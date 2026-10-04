import { MAX_TIMER_MS } from "@open-cr-agent/core/internal";
import { CloudClient, sessionLostReason } from "./client.js";
import type { Credentials } from "./credentials.js";
import type { CloudDeps } from "./deps.js";

// The access token a run's models use at the ocra Cloud gateway lives an
// hour; a run may last longer. While the run lasts, the token is renewed a
// few minutes before it expires, for a runtime that reads its key at each
// call (the direct runtime does).

export const RENEW_BEFORE_MS = 5 * 60_000;
const RETRY_MS = 60_000;

export class GatewayToken {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private failing = false;

  private credentials: Credentials;
  private readonly deps: CloudDeps;
  private readonly warn: (message: string) => void;

  constructor(credentials: Credentials, deps: CloudDeps, warn: (message: string) => void) {
    this.credentials = credentials;
    this.deps = deps;
    this.warn = warn;
  }

  get value(): string {
    return this.credentials.access_token;
  }

  start(): void {
    this.schedule(this.credentials.expires_at - RENEW_BEFORE_MS - this.deps.now());
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.renew(), Math.min(Math.max(delayMs, 0), MAX_TIMER_MS));
    this.timer.unref?.();
  }

  private async renew(): Promise<void> {
    let reason: string;
    try {
      // Asking for more than the token has left renews it.
      const session = await new CloudClient(this.deps).session(2 * RENEW_BEFORE_MS);
      if (this.stopped) return;
      if (session.kind === "ok") {
        this.credentials = session.credentials;
        this.failing = false;
        this.start();
        return;
      }
      reason = session.kind === "signed-out" ? "you signed out" : sessionLostReason(session);
    } catch (error) {
      reason = error instanceof Error ? error.message : "error";
    }
    if (!this.failing) {
      this.warn(
        `could not renew the ocra Cloud token (${reason}); model calls through ocra Cloud fail once it expires`,
      );
      this.failing = true;
    }
    if (this.deps.now() < this.credentials.expires_at) this.schedule(RETRY_MS);
  }
}
