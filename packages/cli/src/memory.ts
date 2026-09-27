import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type Finding,
  MEMORY_PATH,
  type MemoryEntry,
  parseMemory,
  serializeMemory,
} from "@open-cr-agent/core";
import { findRepositoryRoot } from "@open-cr-agent/vcs-local";
import { UsageError } from "./review/args.js";
import { SESSIONS_DIR } from "./review/command.js";
import type { Output } from "./review/progress.js";
import { forTerminal } from "./review/terminal.js";

export const MEMORY_USAGE = `Usage: ocra memory <command>

Remember findings the team accepts, so ocra stops reporting them.
Entries live in ${MEMORY_PATH}; commit it to share them.

Commands:
  list                              Show remembered findings
  add <id> --reason <text>          Remember a finding from the last review
      [--session <dir>]             (default: the newest session in ${SESSIONS_DIR})
`;

export async function memoryCommand(
  argv: string[],
  out: Output,
  cwd: string,
  now = new Date(),
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      reason: { type: "string" },
      session: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, id] = positionals;
  if (values.help || command === undefined) {
    out.write(MEMORY_USAGE);
    return 0;
  }
  const root = await findRepositoryRoot(cwd);
  const memory = await readMemory(root);

  if (command === "list") {
    if (memory.length === 0) out.write("No remembered findings.\n");
    for (const e of memory) {
      out.write(
        forTerminal(`${e.fingerprint.slice(0, 8)}  ${e.file}  ${e.title}\n    ${e.reason}\n`),
      );
    }
    return 0;
  }
  if (command !== "add") throw new UsageError(`Unknown memory command: ${command}`);
  if (!id || id.length < 6)
    throw new UsageError("ocra memory add needs a finding id of at least 6 characters");
  if (!values.reason?.trim()) throw new UsageError("ocra memory add needs --reason");

  const report = values.session ? resolve(cwd, values.session) : await newestSession(root);
  const finding = await findFinding(join(report, "report.json"), id);
  if (memory.some((e) => e.fingerprint === finding.fingerprint)) {
    out.write(`Already remembered: ${forTerminal(finding.title)}\n`);
    return 0;
  }
  const entry: MemoryEntry = {
    fingerprint: finding.fingerprint,
    file: finding.file,
    title: finding.title,
    reason: values.reason.trim(),
    added: now.toISOString().slice(0, 10),
  };
  await writeFile(join(root, MEMORY_PATH), serializeMemory([...memory, entry]));
  out.write(
    forTerminal(
      `Remembered ${finding.fingerprint.slice(0, 8)}: ${finding.title}\nCommit ${MEMORY_PATH} to share it.\n`,
    ),
  );
  return 0;
}

async function readMemory(root: string): Promise<MemoryEntry[]> {
  try {
    return parseMemory(await readFile(join(root, MEMORY_PATH), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function newestSession(root: string): Promise<string> {
  const dir = join(root, SESSIONS_DIR);
  const sessions = (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith(".")).sort();
  // Interrupted runs and --plan leave sessions without a report.
  for (const name of sessions.reverse()) {
    if (existsSync(join(dir, name, "report.json"))) return join(dir, name);
  }
  throw new UsageError(`No finished review in ${SESSIONS_DIR}; run ocra review first`);
}

async function findFinding(reportPath: string, id: string): Promise<Finding> {
  const report = JSON.parse(await readFile(reportPath, "utf8")) as { findings?: Finding[] };
  const matches = (report.findings ?? []).filter((f) => f.fingerprint.startsWith(id));
  if (matches.length === 1) return matches[0] as Finding;
  throw new UsageError(
    matches.length === 0
      ? `No finding ${id} in ${reportPath}`
      : `${id} matches ${matches.length} findings; use more characters`,
  );
}
