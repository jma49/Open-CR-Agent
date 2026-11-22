import { posix } from "node:path";
import { oneShot } from "../agent/model-call.js";
import { mapWithConcurrency } from "../agent/pool.js";
import { roleCall } from "../agent/settings.js";
import type { AgentRuntime, ReviewContext, Usage } from "../contracts.js";
import type { ChangeRequest, FileDiff } from "../domain.js";
import { errorMessage, OcraError } from "../errors.js";
import type { FileEdit, Written } from "../generate/edits.js";
import {
  commitMessage,
  type WriteOptions,
  writeDocComments,
  writeTest,
} from "../generate/generate.js";
import { isTestFile, type TestConvention } from "../generate/languages.js";
import {
  type GenerateKind,
  generationTargets,
  type Skipped,
  type Target,
} from "../generate/targets.js";
import { defaultSelectionPolicy, type SelectionPolicy, selectFiles } from "../select/select.js";
import type { ChangeCommit, VcsAdapter } from "../vcs.js";
import { reviewContext } from "./context.js";
import type { ReviewOptions } from "./options.js";

const MAX_SOURCE_CHARS = 60_000;
const CONCURRENCY = 3;

interface GenerateOptions extends Pick<ReviewOptions, "effort" | "roles"> {
  kind: GenerateKind;
  vcs: VcsAdapter;
  runtime: AgentRuntime;
  selection?: Partial<SelectionPolicy>;
  signal: AbortSignal;
  onUsage: (usage: Usage) => void;
}

export interface Generated {
  // The head the edits were made from.
  headSha: string;
  edits: FileEdit[];
  skipped: Skipped[];
  // Undefined when there is nothing to commit.
  commit?: ChangeCommit;
}

interface Run {
  changeRequest: ChangeRequest;
  diffs: readonly FileDiff[];
  context: ReviewContext;
  list: (dir: string) => Promise<string[]>;
  write: WriteOptions;
}

// Tests or doc comments for the change's source files (ADR-0051), one
// writer call each, from the files a review would select and read through
// its access policy. A file's failed call is a reason it was skipped; the
// run fails only when every call failed.
export async function generateChanges(options: GenerateOptions): Promise<Generated> {
  const { vcs, kind } = options;
  const ask = oneShot(options.runtime, options.onUsage);
  if (!ask) {
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `the ${options.runtime.name} runtime makes no plain completions, which ocra generate needs`,
    );
  }
  const changeRequest = await vcs.getChangeRequest();
  const diffs = await vcs.getDiff();
  const selected = selectFiles(diffs, { ...defaultSelectionPolicy, ...options.selection })
    .filter((d) => d.selected)
    .map((d) => d.diff);
  const { targets, skipped } = generationTargets(kind, selected);
  const run: Run = {
    changeRequest,
    diffs,
    context: reviewContext(vcs, diffs),
    list: memoized((dir) => vcs.listFiles?.(dir) ?? Promise.resolve([])),
    write: { ask, signal: options.signal, call: roleCall("writer", options) },
  };
  const failures: unknown[] = [];
  const written = await mapWithConcurrency(targets, CONCURRENCY, async (target) => {
    try {
      return await (kind === "tests" ? testFor(target, run) : docsFor(target, run));
    } catch (error) {
      if (options.signal.aborted) throw error;
      failures.push(error);
      return { ok: false, reason: errorMessage(error) } satisfies Written;
    }
  });
  const made: { target: Target; edit: FileEdit }[] = [];
  targets.forEach((target, i) => {
    const result = written[i];
    const path = target.diff.newPath;
    if (!result) return;
    if (!result.ok) skipped.push({ path, reason: result.reason });
    else if (made.some((m) => m.edit.path === result.edit.path)) {
      skipped.push({ path, reason: `another file's test is already ${result.edit.path}` });
    } else made.push({ target, edit: result.edit });
  });
  if (made.length === 0 && failures.length > 0) throw failures[0];
  const edits = made.map((m) => m.edit);
  const generated: Generated = { headSha: changeRequest.headSha, edits, skipped };
  if (made.length === 0) return generated;
  return {
    ...generated,
    commit: {
      parent: changeRequest.headSha,
      message: commitMessage(
        kind,
        made.map((m) => m.target.diff.newPath),
        edits.map((e) => e.path),
      ),
      files: made.map(({ target, edit }) => ({
        path: edit.path,
        content: edit.content,
        created: edit.kind === "create",
        executable: edit.kind === "insert" && target.executable,
      })),
    },
  };
}

async function sourceOf(target: Target, run: Run): Promise<string | { skip: string }> {
  const source = await run.context.readFile(target.diff.newPath);
  if (source === undefined) return { skip: "it cannot be read at the head" };
  if (source.length > MAX_SOURCE_CHARS) return { skip: `over ${MAX_SOURCE_CHARS} characters` };
  return source;
}

async function docsFor(target: Target, run: Run): Promise<Written> {
  const source = await sourceOf(target, run);
  if (typeof source !== "string") return { ok: false, reason: source.skip };
  return writeDocComments(
    { changeRequest: run.changeRequest, diff: target.diff, language: target.language, source },
    run.write,
  );
}

async function testFor(target: Target, run: Run): Promise<Written> {
  const convention = target.language.tests;
  const path = convention && (await testPathOf(target.diff.newPath, convention, run));
  if (!path) return { ok: false, reason: "it has no conventional test path" };
  if (!(await isFree(path, run))) return { ok: false, reason: `${path} already exists` };
  const source = await sourceOf(target, run);
  if (typeof source !== "string") return { ok: false, reason: source.skip };
  const example = await exampleTest(path, run);
  return writeTest(
    {
      changeRequest: run.changeRequest,
      diff: target.diff,
      language: target.language,
      source,
      testPath: path,
      ...(example ? { example } : {}),
    },
    run.write,
  );
}

async function testPathOf(
  source: string,
  convention: TestConvention,
  run: Run,
): Promise<string | undefined> {
  const dirs = convention.looksAt(source);
  const listed = new Map(await Promise.all(dirs.map(async (d) => [d, await run.list(d)] as const)));
  return convention.pathFor(source, (dir) => listed.get(dir) ?? []);
}

// Nothing is at the path in the head, and the access policy would let an
// agent read it: a test never lands on a secret's name or in .git.
async function isFree(path: string, run: Run): Promise<boolean> {
  if (run.diffs.some((d) => d.newPath === path)) return false;
  try {
    return (await run.context.readFile(path)) === undefined;
  } catch {
    return false;
  }
}

// A test beside the new one, in the same language, to copy its framework
// and style from.
async function exampleTest(
  path: string,
  run: Run,
): Promise<{ path: string; content: string } | undefined> {
  const dir = posix.dirname(path);
  const ext = posix.extname(path);
  const candidate = (await run.list(dir)).find(
    (f) => f !== path && posix.extname(f) === ext && isTestFile(f),
  );
  if (!candidate) return undefined;
  const content = await run.context.readFile(candidate).catch(() => undefined);
  return content === undefined ? undefined : { path: candidate, content };
}

function memoized(load: (dir: string) => Promise<string[]>): (dir: string) => Promise<string[]> {
  const known = new Map<string, Promise<string[]>>();
  return (dir) => {
    let listed = known.get(dir);
    if (!listed) {
      listed = load(dir).catch(() => []);
      known.set(dir, listed);
    }
    return listed;
  };
}
