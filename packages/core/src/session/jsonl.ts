import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewEvent } from "../pipeline/report.js";

export const EVENTS_FILE = "events.jsonl";
export const REPORT_FILE = "report.json";

export function newSessionId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

// Events are appended synchronously, one JSON object per line, so the log
// stays valid and ordered even if the process dies mid-run.
export class JsonlSessionWriter {
  readonly dir: string;

  constructor(
    sessionsDir: string,
    readonly id: string = newSessionId(),
  ) {
    this.dir = join(sessionsDir, id);
    mkdirSync(this.dir, { recursive: true });
  }

  write(event: ReviewEvent): void {
    const line = JSON.stringify({ time: new Date().toISOString(), ...event });
    appendFileSync(join(this.dir, EVENTS_FILE), `${line}\n`);
    if (event.type === "run_finished") {
      writeFileSync(join(this.dir, REPORT_FILE), `${JSON.stringify(event.report, null, 2)}\n`);
    }
  }
}
