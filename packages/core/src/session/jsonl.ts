import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { serializeOutput, toReportOutput } from "../pipeline/output.js";
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
    // The sessions directory lives in the reviewed tree, which may carry
    // links planted to send the logs, or the .gitignore write, elsewhere.
    for (const dir of [dirname(sessionsDir), sessionsDir]) refuseSymlink(dir);
    this.dir = join(sessionsDir, id);
    mkdirSync(this.dir, { recursive: true });
    // The directory is created before a workspace review reads its diff, and
    // the logs hold code and findings: keep them out of git and out of reviews.
    const fd = openSync(
      join(sessionsDir, ".gitignore"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    );
    try {
      writeSync(fd, "*\n");
    } finally {
      closeSync(fd);
    }
  }

  write(event: ReviewEvent): void {
    const line = serializeOutput({ time: new Date().toISOString(), ...event }, 0);
    appendFileSync(join(this.dir, EVENTS_FILE), `${line}\n`);
    if (event.type === "run_finished") {
      const report = toReportOutput(event.report);
      writeFileSync(join(this.dir, REPORT_FILE), `${serializeOutput(report)}\n`);
    }
  }
}

function refuseSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Refusing to write the session log through the symbolic link ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
