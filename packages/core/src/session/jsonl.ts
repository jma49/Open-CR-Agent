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
import { isNotFound, OcraError } from "../errors.js";
import { newRunId } from "../pipeline/run-id.js";
import { toReportOutput } from "../report/output.js";
import type { ReviewEvent } from "../report/report.js";
import { serializeOutput } from "../report/serialize.js";
import { sealLine } from "./seal.js";

export const EVENTS_FILE = "events.jsonl";
export const REPORT_FILE = "report.json";

// Events are appended synchronously, one JSON object per line, so the log
// stays valid and ordered even if the process dies mid-run. With a seal key
// (this machine's, seal.ts), each line is sealed so that --resume can tell
// it from a line a change brought into the tree.
export class JsonlSessionWriter {
  readonly dir: string;

  readonly id: string;

  private readonly sealKey: string | undefined;

  constructor(sessionsDir: string, id: string = newRunId(), sealKey?: string) {
    this.id = id;
    this.sealKey = sealKey;
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
    const serialized = serializeOutput({ time: new Date().toISOString(), ...event }, 0);
    const line = this.sealKey ? sealLine(this.sealKey, this.id, serialized) : serialized;
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
      throw new OcraError(
        "ACCESS_DENIED",
        `Refusing to write the session log through the symbolic link ${path}`,
      );
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}
