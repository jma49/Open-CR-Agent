import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { errorMessage, proxiedFetch } from "@open-cr-agent/core";
import { classifyChange } from "../ceiling-run.js";
import { type DatasetRecord, loadRecords } from "../dataset.js";
import { exec } from "../exec.js";
import { loadGolden } from "../golden.js";
import {
  byLanguage,
  DEFAULT_MAX_CHANGE_LINES,
  type ImportCandidate,
  importCandidates,
  pickInTurn,
  renderImportSummary,
  type Verdict,
  verdictFor,
} from "../golden-import.js";
import { defaultOcraCommand } from "../reviewer.js";
import { CACHE_DIR, number, type Output, parse } from "./options.js";

const DEFAULT_OUT = ".ocra/eval/aacr-golden-candidates";

// Seams for tests: the dataset rows, and the clone-and-plan classification.
export interface ImportDeps {
  records?: () => Promise<DatasetRecord[]>;
  judge?: (candidate: ImportCandidate) => Promise<Verdict>;
}

export async function goldenImport(
  argv: string[],
  out: Output,
  err: Output,
  deps: ImportDeps = {},
): Promise<number> {
  const { values } = parse(argv);
  if (values.from !== "aacr") throw new Error("golden-import needs --from aacr");
  const limit = number(values.limit, "--limit") ?? 50;
  const seed = number(values.seed, "--seed") ?? 1;
  const maxChangeLines =
    number(values["max-change-lines"], "--max-change-lines") ?? DEFAULT_MAX_CHANGE_LINES;
  const outDir = resolve(values.out ?? DEFAULT_OUT);
  // Candidates are reviewed by hand and moved, never merged into files that
  // are already there.
  const existing = await readdir(outDir).catch(() => [] as string[]);
  if (existing.some((f) => f.endsWith(".json"))) {
    throw new Error(`${outDir} already holds cases; remove them or choose another --out`);
  }

  const golden = await loadGolden(resolve(values["golden-dir"] ?? "evals/golden"));
  const records = await (
    deps.records ?? (() => loadRecords(join(CACHE_DIR, "dataset.json"), proxiedFetch(process.env)))
  )();
  const candidates = importCandidates(records, {
    maxChangeLines,
    exclude: new Set(golden.map((g) => g.headCommit)),
  });
  const languages = values.languages?.split(",").map((l) => l.trim().toLowerCase());
  const queues = byLanguage(
    candidates.filter((c) => !languages || languages.includes(c.instance.language.toLowerCase())),
    seed,
  );
  const log = (message: string) => err.write(`[ocra-eval] ${message}\n`);
  log(
    `${candidates.length} candidate PR(s) with 1-3 in-scope issues and <= ${maxChangeLines} changed lines`,
  );

  const reposDir = values["repos-dir"] ?? join(CACHE_DIR, "repos");
  const command = defaultOcraCommand();
  const cases = await pickInTurn(
    queues,
    limit,
    deps.judge ?? ((candidate) => classifyCandidate(candidate, reposDir, command)),
    log,
  );

  await mkdir(outDir, { recursive: true });
  for (const c of cases) {
    await writeFile(join(outDir, `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`);
  }
  const summary = renderImportSummary(cases, outDir);
  await writeFile(join(outDir, "summary.md"), summary);
  out.write(summary);
  return 0;
}

// The same deterministic classification as the recall ceiling, on the diff
// from the merge base, which is the base a golden case records.
async function classifyCandidate(
  candidate: ImportCandidate,
  reposDir: string,
  command: readonly string[],
): Promise<Verdict> {
  try {
    const { dir, reaches } = await classifyChange(candidate.instance, { reposDir, command });
    const { instance } = candidate;
    // Commit ids are hexadecimal (dataset schema), so none reads as an option.
    const mergeBase = await exec("git", ["merge-base", instance.baseCommit, instance.headCommit], {
      cwd: dir,
    });
    if (mergeBase.exitCode !== 0) {
      return { rejected: `git merge-base failed: ${mergeBase.stderr.trim()}` };
    }
    return verdictFor(candidate, reaches, mergeBase.stdout.trim());
  } catch (error) {
    return { rejected: errorMessage(error).split("\n")[0] ?? "failed" };
  }
}
