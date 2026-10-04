import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { MemoryEntry, OutputFinding } from "@open-cr-agent/core";
import {
  isNotFound,
  MEMORY_PATH,
  parseMemory,
  readReport,
  serializeMemory,
} from "@open-cr-agent/core/internal";
import { findRepositoryRoot } from "@open-cr-agent/vcs-local/internal";
import { EXIT } from "../io/exit.js";
import type { Output } from "../io/output.js";
import { forTerminal } from "../io/terminal.js";
import { UsageError } from "../io/usage-error.js";
import { listSessions, reportPath, SESSIONS_DIR, sessionsDir } from "../session/store.js";

const MEMORY_USAGE = `Usage: ocra memory <command>

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
    return EXIT.ok;
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
    return EXIT.ok;
  }
  if (command !== "add") throw new UsageError(`Unknown memory command: ${command}`);
  if (!id || id.length < 6)
    throw new UsageError("ocra memory add needs a finding id of at least 6 characters");
  if (!values.reason?.trim()) throw new UsageError("ocra memory add needs --reason");

  const report = values.session ? resolve(cwd, values.session) : await newestSession(root);
  const finding = await findFinding(reportPath(report), id);
  if (memory.some((e) => e.fingerprint === finding.fingerprint)) {
    out.write(`Already remembered: ${forTerminal(finding.title)}\n`);
    return EXIT.ok;
  }
  const entry: MemoryEntry = {
    fingerprint: finding.fingerprint,
    file: finding.file,
    title: finding.title,
    reason: values.reason.trim(),
    added: now.toISOString().slice(0, 10),
  };
  await writeRepositoryFile(root, MEMORY_PATH, serializeMemory([...memory, entry]));
  out.write(
    forTerminal(
      `Remembered ${finding.fingerprint.slice(0, 8)}: ${finding.title}\nCommit ${MEMORY_PATH} to share it.\n`,
    ),
  );
  return EXIT.ok;
}

// The repository may be someone else's clone: a planted symlink at
// .ocra/memory.json, or at .ocra, must not make ocra write elsewhere.
async function writeRepositoryFile(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  for (const p of [dirname(target), target]) {
    const stat = await lstat(p).catch(() => undefined);
    if (stat?.isSymbolicLink())
      throw new UsageError(`Refusing to write through the symbolic link ${p}`);
  }
  await mkdir(dirname(target), { recursive: true });
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  );
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

async function readMemory(root: string): Promise<MemoryEntry[]> {
  try {
    return parseMemory(await readFile(join(root, MEMORY_PATH), "utf8"));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function newestSession(root: string): Promise<string> {
  const dir = sessionsDir(root);
  // An interrupted run leaves a session without a report.
  for (const name of (await listSessions(dir)).reverse()) {
    if (existsSync(reportPath(join(dir, name)))) return join(dir, name);
  }
  throw new UsageError(`No finished review in ${SESSIONS_DIR}; run ocra review first`);
}

async function findFinding(reportPath: string, id: string): Promise<OutputFinding> {
  const report = await readReport(reportPath);
  const matches = report.findings.filter((f) => f.fingerprint.startsWith(id));
  const [only] = matches;
  if (only && matches.length === 1) return only;
  throw new UsageError(
    matches.length === 0
      ? `No finding ${id} in ${reportPath}`
      : `${id} matches ${matches.length} findings; use more characters`,
  );
}
