import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fixCommits } from "@open-cr-agent/vcs-local/internal";
import { candidateCase, type MinedClaim } from "../fix-mining.js";
import { blameFix, introducingCommit } from "../fix-mining-git.js";
import { loadGolden } from "../golden.js";
import { DEFAULT_MAX_CHANGE_LINES } from "../golden-import.js";
import { detectLicence, isLicenceSource } from "../licence.js";
import { rootFiles } from "../repos.js";
import { number, type Output, parse } from "./options.js";

const DEFAULT_OUT = ".ocra/eval/fix-golden-candidates";

// golden-import --from fixes: candidates from a local clone's own history,
// labelled by later fixes (fix-mining.ts). Free: no model, no network.
export async function goldenImportFixes(argv: string[], out: Output, err: Output): Promise<number> {
  const { values } = parse(argv);
  const repo = values.repo;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(
      "golden-import --from fixes needs --repo <owner/name>, the clone's GitHub repository",
    );
  }
  const dir = resolve(values["repo-dir"] ?? ".");
  const limit = number(values.limit, "--limit") ?? 50;
  const maxChangeLines =
    number(values["max-change-lines"], "--max-change-lines") ?? DEFAULT_MAX_CHANGE_LINES;
  const outDir = resolve(values.out ?? DEFAULT_OUT);
  const existing = await readdir(outDir).catch(() => [] as string[]);
  if (existing.some((f) => f.endsWith(".json"))) {
    throw new Error(`${outDir} already holds cases; remove them or choose another --out`);
  }
  const golden = new Set(
    (await loadGolden(resolve(values["golden-dir"] ?? "evals/golden"))).map((g) => g.headCommit),
  );
  const log = (message: string) => err.write(`[ocra-eval] ${message}\n`);

  const fixes = await fixCommits(dir, "HEAD");
  const skipped = new Map<string, number>();
  const byCommit = new Map<string, MinedClaim[]>();
  for (const fix of fixes) {
    const blamed = await blameFix(dir, fix);
    if ("skipped" in blamed) {
      skipped.set(blamed.skipped, (skipped.get(blamed.skipped) ?? 0) + 1);
      continue;
    }
    for (const claim of blamed.claims) {
      byCommit.set(claim.introduced, [...(byCommit.get(claim.introduced) ?? []), claim]);
    }
  }
  log(`${fixes.length} fix commit(s), ${byCommit.size} commit(s) they blame`);

  const rejected = new Map<string, number>();
  const reject = (reason: string) => rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
  const cases: { id: string; json: unknown }[] = [];
  // Newest fixes first, as git log listed them: the most recent history is
  // the least likely to be in a model's training data.
  for (const [sha, claims] of byCommit) {
    if (cases.length >= limit) break;
    if (golden.has(sha)) {
      reject("already a golden case");
      continue;
    }
    const commit = await introducingCommit(dir, sha);
    if (!commit) {
      reject("root or merge commit");
      continue;
    }
    if (commit.changedLines > maxChangeLines) {
      reject(`more than ${maxChangeLines} changed lines`);
      continue;
    }
    const licence = detectLicence(await rootFiles(dir, sha, isLicenceSource)).licence;
    const json = candidateCase(commit, claims, { repo, licence });
    cases.push({ id: (json as { id: string }).id, json });
  }

  await mkdir(outDir, { recursive: true });
  for (const c of cases) {
    await writeFile(join(outDir, `${c.id}.json`), `${JSON.stringify(c.json, null, 2)}\n`);
  }
  const summary = renderFixSummary(fixes.length, byCommit.size, cases.length, skipped, rejected);
  await writeFile(join(outDir, "summary.md"), summary);
  out.write(summary);
  log(`wrote ${cases.length} case(s) to ${outDir}`);
  return 0;
}

function renderFixSummary(
  fixes: number,
  blamed: number,
  written: number,
  skipped: ReadonlyMap<string, number>,
  rejected: ReadonlyMap<string, number>,
): string {
  const rows = (counts: ReadonlyMap<string, number>) =>
    [...counts].sort((a, b) => b[1] - a[1]).map(([reason, n]) => `- ${reason}: ${n}`);
  return [
    "# Golden candidates from later fixes",
    "",
    `Unverified: each claim is a line range a later fix or revert rewrote. ${fixes} fix commit(s) blamed ${blamed} earlier commit(s); ${written} candidate case(s) written.`,
    "",
    "Fixes skipped:",
    ...(skipped.size > 0 ? rows(skipped) : ["- none"]),
    "",
    "Commits left out:",
    ...(rejected.size > 0 ? rows(rejected) : ["- none"]),
    "",
  ].join("\n");
}
