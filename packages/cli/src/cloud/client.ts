import {
  accountSchema,
  type DeviceCode,
  deviceCodeSchema,
  memoryAnswerSchema,
  type ProviderEntry,
  preferencesAnswerSchema,
  providerEntrySchema,
  providersAnswerSchema,
  saltSchema,
  type TokenAnswer,
  tokenAnswerSchema,
  uploadAnswerSchema,
} from "@open-cr-agent/cloud-contract";
import { errorMessage, OcraError } from "@open-cr-agent/core";
import type { z } from "zod";
import { VERSION } from "../version.js";
import { type Credentials, readCredentials, writeCredentials } from "./credentials.js";
import type { CloudDeps } from "./deps.js";
import { withFileLock } from "./file-lock.js";

// The one way to ocra Cloud (ADR-0024): every call goes through request(),
// with its user agent and timeout, and every answer is checked against its
// schema (@open-cr-agent/cloud-contract) before a caller sees it. Calls for the account carry the
// saved session's token and renew it on the way.

const USER_AGENT = `ocra/${VERSION}`;
const CLOUD_TIMEOUT_MS = 30_000;

/** A call to ocra Cloud that could not be sent or whose answer cannot be used. */
export class CloudError extends OcraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CLOUD_API_FAILED", message, options);
    this.name = "CloudError";
  }
}

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

/** Why the session cannot be used, as the reason a call to ocra Cloud failed. */
export function sessionLostReason(lost: Exclude<CloudSessionLost, { kind: "signed-out" }>): string {
  return lost.kind === "revoked" ? "your ocra Cloud session ended: run ocra login" : lost.reason;
}

/** An account call's outcome: the value, the HTTP status of a refusal, an answer that is not one, or no session. */
export type CloudResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "status"; status: number }
  | { kind: "malformed" }
  | CloudSessionLost;

export type LoginStart =
  | { kind: "started"; code: DeviceCode }
  | { kind: "refused"; status: number };

export class CloudClient {
  constructor(private readonly deps: CloudDeps) {}

  /** Starts the device flow (RFC 8628, 3.1). */
  async startLogin(server: string): Promise<LoginStart> {
    const res = await this.request(`${server}/api/device/code`, {
      method: "POST",
      body: { client_name: this.deps.clientName },
    });
    const code = res.status === 200 ? await answerOf(res, deviceCodeSchema) : undefined;
    return code ? { kind: "started", code } : { kind: "refused", status: res.status };
  }

  /** One poll of the device flow (RFC 8628, 3.4); an answer that is not one has no field. */
  async pollLogin(server: string, deviceCode: string): Promise<TokenAnswer & { status: number }> {
    return this.tokens(`${server}/api/device/token`, { device_code: deviceCode });
  }

  /** The account a token belongs to; undefined when the server refuses the token. */
  async account(server: string, token: string): Promise<{ login: string } | undefined> {
    const res = await this.request(`${server}/api/me`, { token });
    if (res.status === 401) return undefined;
    if (!res.ok) throw new CloudError(`ocra Cloud answered ${res.status}`);
    const me = await answerOf(res, accountSchema);
    if (!me) throw new CloudError("ocra Cloud's answer names no account");
    return me;
  }

  /** Ends the session on the server; the caller removes the local file. */
  async endSession(credentials: Credentials): Promise<void> {
    await this.request(`${credentials.server}/api/auth/logout`, {
      method: "POST",
      body: {},
      token: credentials.access_token,
    });
  }

  /** The gateway's providers, listed without a session. */
  async providers(
    server: string,
  ): Promise<Exclude<CloudResult<ProviderEntry[]>, CloudSessionLost>> {
    const res = await this.request(`${server}/api/providers`, {});
    if (!res.ok) return { kind: "status", status: res.status };
    const body = await answerOf(res, providersAnswerSchema);
    if (!body) return { kind: "malformed" };
    const entries = body.providers.flatMap((entry) => {
      const parsed = providerEntrySchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    return { kind: "ok", value: entries };
  }

  /**
   * The saved session with a live access token, refreshed (and saved) when
   * it has expired or is about to, or when the server refused `rejected`,
   * the access token a call just got 401 for.
   */
  async session(minValidityMs = 60_000, rejected?: string): Promise<CloudSession> {
    const { deps } = this;
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
      const refreshed = await this.refresh(current);
      if (refreshed.kind !== "revoked") return refreshed;
      // Rotated by a process that did not wait for the lock (an older ocra,
      // or one that gave up waiting): its pair is in the file.
      const latest = await readCredentials(deps.credentialsPath);
      if (!latest || latest.refresh_token === current.refresh_token) return refreshed;
      if (live(latest)) return { kind: "ok", credentials: latest };
      return this.refresh(latest);
    });
  }

  /** The account's repository-hash salt; null while it shares no findings, or on a server without salts. */
  async accountSalt(): Promise<CloudResult<string | null>> {
    const answer = await this.call("/api/account/salt", saltSchema);
    if (answer.kind === "status" && answer.status === 404) return { kind: "ok", value: null };
    return answer.kind === "ok" ? { kind: "ok", value: answer.value.salt } : answer;
  }

  /** The account's settings, as an object for the settings parsers. */
  preferences(): Promise<CloudResult<Record<string, unknown>>> {
    return this.call("/api/preferences", preferencesAnswerSchema);
  }

  /** The findings the account remembers, for one repository's hash or for all. */
  async memory(repoHash?: string): Promise<CloudResult<unknown[]>> {
    const query = repoHash === undefined ? "" : `?repo=${encodeURIComponent(repoHash)}`;
    const answer = await this.call(`/api/memory${query}`, memoryAnswerSchema);
    return answer.kind === "ok" ? { kind: "ok", value: answer.value.entries } : answer;
  }

  /** Sends a review's counts (and shared findings); answers how many findings the server kept. */
  async uploadReview(
    upload: unknown,
  ): Promise<Exclude<CloudResult<{ findings: number }>, { kind: "malformed" }>> {
    const answer = await this.call("/api/reviews", uploadAnswerSchema, {
      method: "POST",
      body: upload,
    });
    // An answer without a count keeps the counts it acknowledges.
    if (answer.kind === "malformed") return { kind: "ok", value: { findings: 0 } };
    return answer.kind === "ok"
      ? { kind: "ok", value: { findings: answer.value.findings ?? 0 } }
      : answer;
  }

  /**
   * A call for the account with the session's token. A 401 for a token this
   * machine still holds live refreshes the session once and retries once.
   * A failure to send the call throws a CloudError.
   */
  private async call<S extends z.ZodType>(
    path: string,
    schema: S,
    init: { method?: string; body?: unknown } = {},
  ): Promise<CloudResult<z.infer<S>>> {
    let session = await this.session();
    if (session.kind !== "ok") return session;
    const send = (c: Credentials) =>
      this.request(`${c.server}${path}`, { ...init, token: c.access_token });
    let res = await send(session.credentials);
    if (res.status === 401) {
      session = await this.session(undefined, session.credentials.access_token);
      if (session.kind !== "ok") return session;
      res = await send(session.credentials);
    }
    if (!res.ok) return { kind: "status", status: res.status };
    const value = await answerOf(res, schema);
    return value === undefined ? { kind: "malformed" } : { kind: "ok", value };
  }

  /** The new pair, saved; revoked when the server refuses the refresh token. */
  private async refresh(saved: Credentials): Promise<CloudSession> {
    let t: TokenAnswer & { status: number };
    try {
      t = await this.tokens(`${saved.server}/api/device/refresh`, {
        refresh_token: saved.refresh_token,
      });
    } catch (error) {
      return { kind: "unreachable", reason: errorMessage(error) };
    }
    if (t.status === 401 || t.error === "invalid_grant") return { kind: "revoked" };
    if (t.status !== 200 || !t.access_token || !t.refresh_token || !t.expires_in) {
      return { kind: "unreachable", reason: `HTTP ${t.status}` };
    }
    const next: Credentials = {
      ...saved,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: this.deps.now() + t.expires_in * 1000,
    };
    await writeCredentials(this.deps.credentialsPath, next);
    return { kind: "ok", credentials: next };
  }

  private async tokens(url: string, body: unknown): Promise<TokenAnswer & { status: number }> {
    const res = await this.request(url, { method: "POST", body });
    return { ...((await answerOf(res, tokenAnswerSchema)) ?? {}), status: res.status };
  }

  private async request(
    url: string,
    init: { method?: string; body?: unknown; token?: string },
  ): Promise<Response> {
    try {
      return await this.deps.fetch(url, {
        ...(init.method ? { method: init.method } : {}),
        headers: {
          "user-agent": USER_AGENT,
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CloudError(errorMessage(error), { cause: error });
    }
  }
}

/** The answer's JSON when it fits the schema; undefined when it is not JSON or does not fit. */
async function answerOf<S extends z.ZodType>(
  res: Response,
  schema: S,
): Promise<z.infer<S> | undefined> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
