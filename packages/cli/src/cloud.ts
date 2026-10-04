import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage } from "@open-cr-agent/core/internal";
import { UsageError } from "./review/args.js";
import type { Output } from "./review/progress.js";
import { forTerminal } from "./review/terminal.js";
import { VERSION } from "./version.js";

// ocra Cloud sign-in (ADR-0024): `ocra login` runs the OAuth device flow
// (RFC 8628) against ocra Cloud, `ocra whoami` shows the account, and
// `ocra logout` ends the session. Nothing here runs unless one of these
// commands is used: a self-hosted user never sees a login prompt.

// ocra Cloud is in development and has no public address yet; until it
// does, the server is named with OCRA_CLOUD_URL.

export const LOGIN_USAGE = `Usage: ocra login [--no-browser]
       ocra logout
       ocra whoami

Sign in to ocra Cloud with GitHub, so reviews can use the model keys stored
there. ocra login shows a code, opens the browser to confirm it, and saves the
session to ${credentialsHint()} (readable only by you).

Environment:
  OCRA_CLOUD=off   Disable ocra Cloud: these commands refuse to run
  OCRA_CLOUD_URL   The ocra Cloud server (required while ocra Cloud is in development)
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
  const base =
    process.platform === "win32"
      ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "ocra", "credentials.json");
}

function cloudUrl(env: CloudDeps["env"]): string {
  if (!env.OCRA_CLOUD_URL) {
    throw new UsageError("ocra Cloud is not open yet: set OCRA_CLOUD_URL to a server to sign in");
  }
  let url: URL;
  try {
    url = new URL(env.OCRA_CLOUD_URL);
  } catch {
    throw new UsageError(`OCRA_CLOUD_URL is not a URL: ${env.OCRA_CLOUD_URL}`);
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

export async function readCredentials(path: string): Promise<Credentials | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const c = JSON.parse(text) as Partial<Credentials>;
  if (!c.server || !c.access_token || !c.refresh_token || typeof c.expires_at !== "number") {
    return undefined;
  }
  return c as Credentials;
}

async function writeCredentials(path: string, c: Credentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  // writeFile keeps the mode of a file that already exists.
  await chmod(path, 0o600);
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
  const saved = await readCredentials(deps.credentialsPath);
  if (!saved) return undefined;
  if (saved.expires_at - deps.now() > minValidityMs) return saved;
  const { status, body } = await postJson(deps, `${saved.server}/api/device/refresh`, {
    refresh_token: saved.refresh_token,
  });
  const t = body as TokenAnswer;
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
  const saved = await readCredentials(deps.credentialsPath);
  if (saved) {
    // Ends the session on the server too; the local file goes either way.
    const session = await cloudSession(deps).catch(() => undefined);
    if (session) {
      await postJson(deps, `${session.server}/api/auth/logout`, {}, session.access_token).catch(
        () => {},
      );
    }
  }
  await rm(deps.credentialsPath, { force: true });
  out.write(saved ? "Signed out.\n" : "Not signed in.\n");
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
