import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type CodeGraph, serializeGraph, updateGraph } from "@open-cr-agent/code-graph";
import { errorMessage } from "@open-cr-agent/core";
import {
  blobReader,
  findRepositoryRoot,
  resolveCommit,
  revisionFiles,
} from "@open-cr-agent/vcs-local/internal";
import { readGraphFile } from "../graph/file.js";
import { EXIT } from "../io/exit.js";
import type { Output } from "../io/output.js";
import { refuseLinkedOutput, writeOutputFile } from "../io/output-file.js";
import { forTerminal } from "../io/terminal.js";
import { UsageError } from "../io/usage-error.js";

export const GRAPH_USAGE = `Usage: ocra graph --out <file> [options]

Write the code graph of a commit: each source file's definitions and the
lines its names are used on, for "ocra review --graph". An existing graph at
--out is updated: only files it lacks are read and parsed. Reads git objects
only; runs nothing from the repository.

Options:
  --out <file>    The graph file to write or update
  --rev <commit>  The commit (default: HEAD)
  -h, --help      Show help
`;

const MAX_BLOB_BYTES = 1_000_000;

export async function graphCommand(
  argv: string[],
  out: Output,
  err: Output,
  cwd: string,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      out: { type: "string" },
      rev: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    out.write(GRAPH_USAGE);
    return EXIT.ok;
  }
  if (!values.out) throw new UsageError("--out needs a file");
  if (values.rev === "") throw new UsageError("--rev needs a commit");
  const root = await findRepositoryRoot(cwd);
  const file = resolve(cwd, values.out);
  await refuseLinkedOutput(root, file);
  const commit = await resolveCommit(root, values.rev ?? "HEAD");
  const previous = await readPrevious(file, err);
  const update = await updateGraph(
    previous,
    await revisionFiles(root, commit),
    blobReader(root, MAX_BLOB_BYTES),
    {
      revision: commit,
      maxBlobBytes: MAX_BLOB_BYTES,
    },
  );
  await writeOutputFile(root, file, serializeGraph(update.graph));
  const skipped = update.skipped.length ? `, ${update.skipped.length} skipped` : "";
  out.write(
    forTerminal(
      `Code graph of ${commit.slice(0, 12)}: ${plural(update.graph.files.size, "file")} (${update.parsed} parsed, ${update.reused} reused${skipped}) in ${values.out}\n`,
    ),
  );
  return EXIT.ok;
}

async function readPrevious(file: string, err: Output): Promise<CodeGraph | undefined> {
  try {
    return await readGraphFile(file);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      err.write(forTerminal(`[ocra] Building the graph again: ${file} ${errorMessage(error)}\n`));
    }
    return undefined;
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
