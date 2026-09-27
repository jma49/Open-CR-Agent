import { describe, expect, it } from "vitest";
import type { PriorFinding } from "../domain.js";
import type { ReviewReport } from "./report.js";
import { finding, runtime, twoFiles, vcs } from "./run.fakes.js";
import { runReview } from "./run.js";

const head = { "src/a.ts": "keep\nconst a = 1;\n", "src/b.ts": "keep\nconst b = 2;\n" };

function asPrior(report: ReviewReport): PriorFinding[] {
  return report.findings.map((f) => ({
    fingerprint: f.fingerprint,
    title: f.title,
    file: f.file,
    severity: f.severity,
    commented: true,
    ...(f.quote ? { quote: f.quote } : {}),
  }));
}

function reporting(...findings: ReturnType<typeof finding>[]) {
  return runtime(async function* (spec) {
    for (const f of findings) yield { type: "finding", taskId: spec.taskId, finding: f };
    yield { type: "done", taskId: spec.taskId };
  });
}

async function review(
  files: Record<string, string>,
  rt: ReturnType<typeof runtime>,
  prior?: PriorFinding[],
) {
  const adapter = vcs(files, twoFiles);
  if (prior) adapter.getPriorReview = async () => ({ findings: prior });
  return runReview({ vcs: adapter, runtime: rt, verify: false, judge: false });
}

describe("runReview against the previous review", () => {
  it("compares with the previous review and survives failing to load it", async () => {
    const rt = runtime(async function* (spec) {
      yield { type: "finding", taskId: spec.taskId, finding: finding("src/a.ts", "const a = 1;") };
      yield { type: "done", taskId: spec.taskId };
    });
    const first = await runReview({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      verify: false,
      judge: false,
    });
    const fingerprint = first.findings[0]?.fingerprint ?? "";
    const old = { title: "t", severity: "warning" as const, commented: true };

    const withPrior = vcs({}, twoFiles);
    withPrior.getPriorReview = async () => ({
      findings: [
        { ...old, fingerprint, file: "src/a.ts" },
        { ...old, fingerprint: "gone", file: "src/b.ts" },
      ],
    });
    const second = await runReview({ vcs: withPrior, runtime: rt, verify: false, judge: false });
    expect(second.findings[0]?.status).toBe("unfixed");
    expect(second.rereview?.fixed.map((f) => f.fingerprint)).toEqual(["gone"]);

    const broken = vcs({}, twoFiles);
    broken.getPriorReview = async () => {
      throw new Error("HTTP 502");
    };
    const third = await runReview({ vcs: broken, runtime: rt, verify: false, judge: false });
    expect(third.findings).toHaveLength(1);
    expect(third.rereview).toBeUndefined();
    expect(third.warnings).toContain("could not load the previous review: HTTP 502");
  });

  it("stays quiet about findings in the repository's memory and tells reviewers", async () => {
    const rt = runtime(async function* (spec) {
      yield { type: "finding", taskId: spec.taskId, finding: finding("src/a.ts", "const a = 1;") };
      yield { type: "done", taskId: spec.taskId };
    });
    const first = await runReview({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      verify: false,
      judge: false,
    });
    const entry = {
      fingerprint: first.findings[0]?.fingerprint ?? "",
      file: "src/a.ts",
      title: "t",
      reason: "known and accepted",
    };
    const memory = JSON.stringify({ accepted: [entry] });
    const second = await runReview({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      verify: false,
      judge: false,
      readTrusted: async (p) => (p === ".ocra/memory.json" ? memory : undefined),
    });
    expect(second.findings).toEqual([]);
    expect(second.remembered).toEqual([entry]);
    expect(rt.specs.at(-1)?.userPrompt).toContain("- src/a.ts: t (accepted: known and accepted)");
  });

  it("keeps the verdict when a finding is not reported again but its code is unchanged", async () => {
    const critical = finding("src/a.ts", "const a = 1;", { severity: "critical" });
    const first = await review(head, reporting(critical));
    expect(first.verdict).toBe("significant_concerns");
    expect(first.findings[0]?.quote).toMatchObject({ lines: 1 });

    const second = await review(head, reporting(), asPrior(first));
    expect(second.findings).toEqual([]);
    expect(second.rereview?.fixed).toEqual([]);
    expect(second.rereview?.notReproduced.map((f) => f.fingerprint)).toEqual([
      first.findings[0]?.fingerprint,
    ]);
    expect(second.verdict).toBe("significant_concerns");
  });

  it("does not take another quote or category for a fix", async () => {
    const first = await review(head, reporting(finding("src/a.ts", "const a = 1;")));
    const requoted = finding("src/a.ts", "keep", { category: "style" });
    const second = await review(head, reporting(requoted), asPrior(first));
    expect(second.findings[0]?.category).toBe("correctness");
    expect(second.findings[0]?.status).toBe("new");
    expect(second.rereview?.fixed).toEqual([]);
    expect(second.rereview?.notReproduced).toHaveLength(1);
  });

  it("ignores the category a model sends, so the fingerprint stays the same", async () => {
    const first = await review(head, reporting(finding("src/a.ts", "const a = 1;")));
    const relabelled = finding("src/a.ts", "const a = 1;", { category: "bug" });
    const second = await review(head, reporting(relabelled), asPrior(first));
    expect(second.findings[0]?.fingerprint).toBe(first.findings[0]?.fingerprint);
    expect(second.findings[0]?.status).toBe("unfixed");
  });

  it("judges a finding fixed once its code or its file is gone", async () => {
    const first = await review(
      head,
      reporting(
        finding("src/a.ts", "const a = 1;", { severity: "critical" }),
        finding("src/b.ts", "const b = 2;"),
      ),
    );
    const changed = { "src/a.ts": "keep\nconst a = 2;\n" };
    const second = await review(changed, reporting(), asPrior(first));
    expect(second.rereview?.fixed.map((f) => f.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(second.verdict).toBe("approved");
  });

  it("never resolves earlier findings stored without a code signature", async () => {
    const legacy = asPrior(await review(head, reporting(finding("src/a.ts", "const a = 1;"))));
    const withoutQuote = legacy.map(({ quote: _quote, ...rest }) => rest);
    const second = await review({ "src/a.ts": "changed\n" }, reporting(), withoutQuote);
    expect(second.rereview?.fixed).toEqual([]);
    expect(second.rereview?.notReproduced).toHaveLength(1);
    expect(second.verdict).toBe("approved_with_comments");
  });
});
