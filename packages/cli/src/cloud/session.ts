import { errorMessage } from "@open-cr-agent/core/internal";
import { VERSION } from "../version.js";
import { type Credentials, readCredentials, writeCredentials } from "./credentials.js";
import type { CloudDeps } from "./deps.js";
import { withFileLock } from "./file-lock.js";
import { postJson, type TokenAnswer } from "./http.js";

/** The saved session, or why there is none to use for this run. */
export type CloudSession =
  | { kind: "ok"; credentials: Credentials }
  // No session saved on this machine.
  | { kind: "signed-out" }
  // The server refused the session: only ocra login brings it back.
  | { kind: "revoked" }
  // The server could not be asked (network, 5xx, 429): the session may still be good.
  | { kind: "unreachable"; reason: string };

export type CloudSessionLost = Exclude<CloudSession, { kind: "ok" }>;

/**
 * The saved session with a live access token, refreshed (and saved) when
 * it has expired or is about to, or when the server refused `rejected`,
 * the access token a call just got 401 for.
 */
export async function cloudSession(
  deps: CloudDeps,
  minValidityMs = 60_000,
  rejected?: string,
): Promise<CloudSession> {
  const live = (c: Credentials) =>
    c.access_token !== rejected && c.expires_at - deps.now() > minValidityMs;
  const saved = await readCredentials(deps.credentialsPath);
  if (!saved) return { kind: "signed-out" };
  if (live(saved)) return { kind: "ok", credentials: saved };
  // One refresh at a time on this machine: the server rotates the refresh
  // token, so of two processes refreshing with one token, one is refused.
  return withFileLock(`${deps.credentialsPath}.lock`, async (): Promise<CloudSession> => {
    const current = await readCredentials(deps.credentialsPath);
    if (!current) return { kind: "signed-out" };
    // Another process may have refreshed while this one waited for the lock.
    if (live(current)) return { kind: "ok", credentials: current };
    const refreshed = await refresh(deps, current);
    if (refreshed.kind !== "revoked") return refreshed;
    // Rotated by a process that did not wait for the lock (an older ocra,
    // or one that gave up waiting): its pair is in the file.
    const latest = await readCredentials(deps.credentialsPath);
    if (!latest || latest.refresh_token === current.refresh_token) return refreshed;
    if (live(latest)) return { kind: "ok", credentials: latest };
    return refresh(deps, latest);
  });
}

/** The new pair, saved; revoked when the server refuses the refresh token. */
async function refresh(deps: CloudDeps, saved: Credentials): Promise<CloudSession> {
  let answer: Awaited<ReturnType<typeof postJson>>;
  try {
    answer = await postJson(deps, `${saved.server}/api/device/refresh`, {
      refresh_token: saved.refresh_token,
    });
  } catch (error) {
    return { kind: "unreachable", reason: errorMessage(error) };
  }
  const t = answer.body as TokenAnswer;
  if (answer.status === 401 || t.error === "invalid_grant") return { kind: "revoked" };
  if (answer.status !== 200 || !t.access_token || !t.refresh_token || !t.expires_in) {
    return { kind: "unreachable", reason: `HTTP ${answer.status}` };
  }
  const next: Credentials = {
    ...saved,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: deps.now() + t.expires_in * 1000,
  };
  await writeCredentials(deps.credentialsPath, next);
  return { kind: "ok", credentials: next };
}

/** Why the session cannot be used, as the reason a call to ocra Cloud failed. */
export function sessionLostReason(lost: Exclude<CloudSessionLost, { kind: "signed-out" }>): string {
  return lost.kind === "revoked" ? "your ocra Cloud session ended: run ocra login" : lost.reason;
}

export type CloudAnswer =
  | { kind: "answered"; res: Response; credentials: Credentials }
  | CloudSessionLost;

/**
 * A call to ocra Cloud (`path` under its server) with the session's token.
 * A 401 for a token this machine still holds live refreshes the session
 * once and retries once. A failure to send the call throws.
 */
export async function cloudFetch(
  deps: CloudDeps,
  path: string,
  init: { method?: string; body?: string; timeoutMs?: number } = {},
): Promise<CloudAnswer> {
  const call = (c: Credentials) =>
    deps.fetch(`${c.server}${path}`, {
      ...(init.method ? { method: init.method } : {}),
      headers: {
        authorization: `Bearer ${c.access_token}`,
        "user-agent": `ocra/${VERSION}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
  let session = await cloudSession(deps);
  if (session.kind !== "ok") return session;
  let res = await call(session.credentials);
  if (res.status !== 401) return { kind: "answered", res, credentials: session.credentials };
  session = await cloudSession(deps, undefined, session.credentials.access_token);
  if (session.kind !== "ok") return session;
  res = await call(session.credentials);
  return { kind: "answered", res, credentials: session.credentials };
}
