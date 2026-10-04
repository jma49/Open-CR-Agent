import { rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import { errorMessage } from "@open-cr-agent/core/internal";
import { saveAccountSalt } from "../cloud/account-salt.js";
import { signInPage } from "../cloud/browser.js";
import { CloudClient } from "../cloud/client.js";
import {
  type Credentials,
  credentialsHint,
  loadCredentials,
  writeCredentials,
} from "../cloud/credentials.js";
import { type CloudDeps, cloudUrl, DEFAULT_CLOUD_URL } from "../cloud/deps.js";
import type { TokenAnswer } from "../cloud/wire.js";
import { EXIT } from "../io/exit.js";
import type { Output } from "../io/output.js";
import { forTerminal } from "../io/terminal.js";

// ocra Cloud sign-in (ADR-0024): `ocra login` runs the OAuth device flow
// (RFC 8628) against ocra Cloud, `ocra whoami` shows the account, and
// `ocra logout` ends the session. Nothing here runs unless one of these
// commands is used: a self-hosted user never sees a login prompt.

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

export async function loginCommand(
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
    return EXIT.ok;
  }
  if (deps.env.OCRA_CLOUD === "off") {
    err.write("ocra Cloud is off (OCRA_CLOUD=off).\n");
    return EXIT.error;
  }
  if (command === "whoami") return whoami(out, err, deps);
  if (command === "logout") return logout(out, deps);
  return login(out, err, deps, !values["no-browser"]);
}

async function whoami(out: Output, err: Output, deps: CloudDeps): Promise<number> {
  const client = new CloudClient(deps);
  const session = await client.session();
  if (session.kind === "signed-out") {
    err.write("Not signed in. Run ocra login.\n");
    return EXIT.notSignedIn;
  }
  if (session.kind === "unreachable") {
    err.write(forTerminal(`ocra Cloud could not be reached (${session.reason}).\n`));
    return EXIT.error;
  }
  const me =
    session.kind === "ok"
      ? await client.account(session.credentials.server, session.credentials.access_token)
      : undefined;
  if (session.kind !== "ok" || !me) {
    err.write("Your ocra Cloud session ended. Run ocra login.\n");
    return EXIT.notSignedIn;
  }
  out.write(forTerminal(`${me.login} on ${session.credentials.server}\n`));
  return EXIT.ok;
}

async function logout(out: Output, deps: CloudDeps): Promise<number> {
  const saved = await loadCredentials(deps.credentialsPath);
  if (saved && saved !== "unreadable") {
    // Ends the session on the server too; the local file goes either way.
    const client = new CloudClient(deps);
    const session = await client.session().catch(() => undefined);
    if (session?.kind === "ok") await client.endSession(session.credentials).catch(() => {});
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
  return EXIT.ok;
}

async function login(out: Output, err: Output, deps: CloudDeps, browser: boolean): Promise<number> {
  const server = cloudUrl(deps.env);
  const client = new CloudClient(deps);
  const start = await client.startLogin(server);
  if (start.kind === "refused") {
    err.write(`ocra Cloud did not start a login (HTTP ${start.status}). Try again in a minute.\n`);
    return EXIT.error;
  }
  const { code } = start;
  out.write(
    forTerminal(
      `Confirm this code in your browser: ${code.user_code}\n` +
        `  ${code.verification_uri_complete}\n` +
        `(or open ${code.verification_uri} and type it)\n\nWaiting for approval...\n`,
    ),
  );
  if (browser) {
    const page = signInPage(code.verification_uri_complete, server);
    if (page) deps.openBrowser(page);
    else err.write(`ocra opens only pages on ${server}; open the address above yourself.\n`);
  }

  let interval = (code.interval ?? 5) * 1000;
  const deadline = deps.now() + (code.expires_in ?? 600) * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(interval);
    let t: TokenAnswer & { status: number };
    try {
      t = await client.pollLogin(server, code.device_code);
    } catch (error) {
      // A dropped connection is retried on the next tick.
      err.write(forTerminal(`(${errorMessage(error)}; retrying)\n`));
      continue;
    }
    if (t.status === 200 && t.access_token && t.refresh_token && t.expires_in) {
      // The tokens are issued: they are saved even when the login cannot be read.
      let login: string | undefined;
      let unknown = "";
      try {
        login = (await client.account(server, t.access_token))?.login;
      } catch (error) {
        unknown = errorMessage(error);
      }
      const credentials: Credentials = {
        server,
        login: login ?? "",
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: deps.now() + t.expires_in * 1000,
      };
      await writeCredentials(deps.credentialsPath, credentials);
      // Best effort: each signed-in review asks again.
      await client
        .accountSalt()
        .then((salt) =>
          salt.kind === "ok" ? saveAccountSalt(deps.credentialsPath, salt.value) : undefined,
        )
        .catch(() => {});
      out.write(
        forTerminal(
          login
            ? `Signed in as ${login}.\n`
            : `Signed in; the login is unknown${unknown ? ` (${unknown})` : ""}: ocra whoami asks again.\n`,
        ),
      );
      return EXIT.ok;
    }
    if (t.error === "authorization_pending") continue;
    if (t.error === "slow_down") {
      interval = typeof t.interval === "number" ? t.interval * 1000 : interval + 5000;
      continue;
    }
    if (t.error === "access_denied") {
      err.write("Login denied in the browser.\n");
      return EXIT.notSignedIn;
    }
    if (t.error === "expired_token") break;
    err.write(forTerminal(`Login failed: ${t.error ?? `HTTP ${t.status}`}\n`));
    return EXIT.error;
  }
  err.write("The code expired before it was confirmed. Run ocra login again.\n");
  return EXIT.notSignedIn;
}
