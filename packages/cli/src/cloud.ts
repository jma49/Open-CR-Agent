import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage } from "@open-cr-agent/core/internal";
import { fetchAccountSalt, saveAccountSalt } from "./account-salt.js";
import { withFileLock } from "./file-lock.js";
import { writePrivateFile } from "./private-file.js";
import { UsageError } from "./review/args.js";
import type { Output } from "./review/progress.js";
import { forTerminal } from "./review/terminal.js";
import { VERSION } from "./version.js";

// ocra Cloud sign-in (ADR-0024): `ocra login` runs the OAuth device flow
// (RFC 8628) against ocra Cloud, `ocra whoami` shows the account, and
// `ocra logout` ends the session. Nothing here runs unless one of these
// commands is used: a self-hosted user never sees a login prompt.

/** ocra Cloud's address; OCRA_CLOUD_URL names another server. */
export const DEFAULT_CLOUD_URL = "https://app.ocracloud.com";

export const LOGIN_USAGE = `Usage: ocra login [--no-browser]
       ocra logout
       ocra whoami

Sign in to ocra Cloud with GitHub, so reviews can use the model keys stored
there. ocra login shows a code, opens the browser to confirm it, and saves the
session to ${credentialsHint()} (readable only by you).

Environment:
  OCRA_CLOUD=off   Disable ocra Cloud: these commands refuse to run
  OCRA_CLOUD_URL   Another ocra Cloud server (default ${DEFAULT_CLOUD_URL})
`;

export type Credentials = {
  server: string;
  login: string;
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds when the access token expires. */
  expires_at: number;
};

export type CloudDeps = {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  openBrowser: (url: string) => void;
  credentialsPath: string;
  clientName: string;
};

export function defaultCloudDeps(env: CloudDeps["env"] = process.env): CloudDeps {
  return {
    env,
    fetch: globalThis.fetch,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    openBrowser,
    credentialsPath: credentialsPath(env),
    clientName: `${hostname()} (ocra ${VERSION})`,
  };
}

function credentialsHint(): string {
  return process.platform === "win32"
    ? "%APPDATA%\\ocra\\credentials.json"
    : "~/.config/ocra/credentials.json";
}

export function credentialsPath(env: CloudDeps["env"]): string {
  return join(ocraConfigDir(env), "credentials.json");
}

/** ~/.config/ocra ($XDG_CONFIG_HOME/ocra), or %APPDATA%\ocra on Windows: this machine's own. */
export function ocraConfigDir(env: CloudDeps["env"]): string {
  const base =
    process.platform === "win32"
      ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "ocra");
}

function cloudUrl(env: CloudDeps["env"]): string {
  const named = env.OCRA_CLOUD_URL || DEFAULT_CLOUD_URL;
  let url: URL;
  try {
    url = new URL(named);
  } catch {
    throw new UsageError(`OCRA_CLOUD_URL is not a URL: ${named}`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new UsageError(`OCRA_CLOUD_URL must use https: ${url}`);
  }
  return url.origin;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed as well; a missing opener is not an error.
  }
}

/**
 * The saved session; undefined when there is none or the file does not hold
 * one, which `warn` hears about (a file cut short by a crash, or edited).
 */
export async function readCredentials(
  path: string,
  warn?: (message: string) => void,
): Promise<Credentials | undefined> {
  const saved = await loadCredentials(path);
  if (saved !== "unreadable") return saved;
  warn?.(`ignoring ${path}: it holds no ocra Cloud session; run ocra login to sign in again`);
  return undefined;
}

async function loadCredentials(path: string): Promise<Credentials | "unreadable" | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let c: Partial<Credentials> | null;
  try {
    c = JSON.parse(text) as Partial<Credentials> | null;
  } catch {
    return "unreadable";
  }
  if (
    typeof c !== "object" ||
    c === null ||
    !c.server ||
    !c.access_token ||
    !c.refresh_token ||
    typeof c.expires_at !== "number"
  ) {
    return "unreadable";
  }
  return c as Credentials;
}

async function writeCredentials(path: string, c: Credentials): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(c, null, 2)}\n`);
}

type TokenAnswer = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  interval?: number;
};

async function postJson(deps: CloudDeps, url: string, body: unknown, token?: string) {
  const res = await deps.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": `ocra/${VERSION}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function fetchMe(deps: CloudDeps, server: string, token: string) {
  const res = await deps.fetch(`${server}/api/me`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": `ocra/${VERSION}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) return undefined;
  if (!res.ok) throw new Error(`ocra Cloud answered ${res.status}`);
  return (await res.json()) as { login: string };
}

/**
 * The saved session with a live access token, refreshed (and saved) when
 * it has expired or is about to; undefined when not signed in or the
 * session was revoked.
 */
export async function cloudSession(
  deps: CloudDeps,
  minValidityMs = 60_000,
): Promise<Credentials | undefined> {
  const live = (c: Credentials) => c.expires_at - deps.now() > minValidityMs;
  const saved = await readCredentials(deps.credentialsPath);
  if (!saved || live(saved)) return saved;
  // One refresh at a time on this machine: the server rotates the refresh
  // token, so of two processes refreshing with one token, one is refused.
  return withFileLock(`${deps.credentialsPath}.lock`, async () => {
    const current = await readCredentials(deps.credentialsPath);
    // Another process may have refreshed while this one waited for the lock.
    if (!current || live(current)) return current;
    const refreshed = await refresh(deps, current);
    if (refreshed !== "rejected") return refreshed;
    // Rotated by a process that did not wait for the lock (an older ocra,
    // or one that gave up waiting): its pair is in the file.
    const latest = await readCredentials(deps.credentialsPath);
    if (!latest || latest.refresh_token === current.refresh_token) return undefined;
    if (live(latest)) return latest;
    const again = await refresh(deps, latest);
    return again === "rejected" ? undefined : again;
  });
}

/** The new pair, saved; "rejected" when the server refuses the refresh token. */
async function refresh(
  deps: CloudDeps,
  saved: Credentials,
): Promise<Credentials | "rejected" | undefined> {
  const { status, body } = await postJson(deps, `${saved.server}/api/device/refresh`, {
    refresh_token: saved.refresh_token,
  });
  const t = body as TokenAnswer;
  if (status === 401 || t.error === "invalid_grant") return "rejected";
  if (status !== 200 || !t.access_token || !t.refresh_token || !t.expires_in) return undefined;
  const next: Credentials = {
    ...saved,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: deps.now() + t.expires_in * 1000,
  };
  await writeCredentials(deps.credentialsPath, next);
  return next;
}

export async function cloudCommand(
  command: "login" | "logout" | "whoami",
  argv: string[],
  out: Output,
  err: Output,
  deps: CloudDeps,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: { "no-browser": { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    out.write(LOGIN_USAGE);
    return 0;
  }
  if (deps.env.OCRA_CLOUD === "off") {
    err.write("ocra Cloud is off (OCRA_CLOUD=off).\n");
    return 2;
  }
  if (command === "whoami") return whoami(out, err, deps);
  if (command === "logout") return logout(out, deps);
  return login(out, err, deps, !values["no-browser"]);
}

async function whoami(out: Output, err: Output, deps: CloudDeps): Promise<number> {
  const session = await cloudSession(deps);
  if (!session) {
    err.write("Not signed in. Run ocra login.\n");
    return 1;
  }
  const me = await fetchMe(deps, session.server, session.access_token);
  if (!me) {
    err.write("The saved session was revoked. Run ocra login.\n");
    return 1;
  }
  out.write(forTerminal(`${me.login} on ${session.server}\n`));
  return 0;
}

async function logout(out: Output, deps: CloudDeps): Promise<number> {
  const saved = await loadCredentials(deps.credentialsPath);
  if (saved && saved !== "unreadable") {
    // Ends the session on the server too; the local file goes either way.
    const session = await cloudSession(deps).catch(() => undefined);
    if (session) {
      await postJson(deps, `${session.server}/api/auth/logout`, {}, session.access_token).catch(
        () => {},
      );
    }
  }
  await rm(deps.credentialsPath, { force: true });
  await saveAccountSalt(deps.credentialsPath, null);
  out.write(
    saved === "unreadable"
      ? "Removed the saved session, which could not be read.\n"
      : saved
        ? "Signed out.\n"
        : "Not signed in.\n",
  );
  return 0;
}

async function login(out: Output, err: Output, deps: CloudDeps, browser: boolean): Promise<number> {
  const server = cloudUrl(deps.env);
  const start = await postJson(deps, `${server}/api/device/code`, { client_name: deps.clientName });
  const code = start.body as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (
    start.status !== 200 ||
    !code.device_code ||
    !code.user_code ||
    !code.verification_uri_complete
  ) {
    err.write(`ocra Cloud did not start a login (HTTP ${start.status}). Try again in a minute.\n`);
    return 2;
  }
  out.write(
    forTerminal(
      `Confirm this code in your browser: ${code.user_code}\n` +
        `  ${code.verification_uri_complete}\n` +
        `(or open ${code.verification_uri} and type it)\n\nWaiting for approval...\n`,
    ),
  );
  if (browser) deps.openBrowser(code.verification_uri_complete);

  let interval = (code.interval ?? 5) * 1000;
  const deadline = deps.now() + (code.expires_in ?? 600) * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(interval);
    let answer: { status: number; body: Record<string, unknown> };
    try {
      answer = await postJson(deps, `${server}/api/device/token`, {
        device_code: code.device_code,
      });
    } catch (error) {
      // A dropped connection is retried on the next tick.
      err.write(forTerminal(`(${errorMessage(error)}; retrying)\n`));
      continue;
    }
    const t = answer.body as TokenAnswer;
    if (answer.status === 200 && t.access_token && t.refresh_token && t.expires_in) {
      const me = await fetchMe(deps, server, t.access_token);
      const credentials: Credentials = {
        server,
        login: me?.login ?? "",
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: deps.now() + t.expires_in * 1000,
      };
      await writeCredentials(deps.credentialsPath, credentials);
      // Best effort: each signed-in review asks again.
      await fetchAccountSalt(deps, server, t.access_token)
        .then((salt) => saveAccountSalt(deps.credentialsPath, salt))
        .catch(() => {});
      out.write(forTerminal(`Signed in as ${credentials.login}.\n`));
      return 0;
    }
    if (t.error === "authorization_pending") continue;
    if (t.error === "slow_down") {
      interval = typeof t.interval === "number" ? t.interval * 1000 : interval + 5000;
      continue;
    }
    if (t.error === "access_denied") {
      err.write("Login denied in the browser.\n");
      return 1;
    }
    if (t.error === "expired_token") break;
    err.write(forTerminal(`Login failed: ${t.error ?? `HTTP ${answer.status}`}\n`));
    return 2;
  }
  err.write("The code expired before it was confirmed. Run ocra login again.\n");
  return 1;
}
