import { describe, expect, it } from "vitest";
import type { PriorFinding } from "../domain.js";
import type { ReviewReport } from "../report/report.js";
import { quoteSignature } from "../rereview/quote.js";
import { finding, patch, runtime, twoFiles, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const head = { "src/a.ts": "keep\nconst a = 1;\n", "src/b.ts": "keep\nconst b = 2;\n" };

function asPrior(report: ReviewReport): PriorFinding[] {
  return report.findings.map((f) => ({
    fingerprint: f.fingerprint,
    title: f.title,
    file: f.file,
    severity: f.severity,
    commented: true,
    ...(f.quote ? { quote: f.quote } : {}),
    ...(f.verification ? { verification: f.verification } : {}),
  }));
}

function reporting(...findings: ReturnType<typeof finding>[]) {
  return runtime(async function* (spec) {
    for (const f of findings) yield { type: "finding", taskId: spec.taskId, finding: f };
    yield { type: "done", taskId: spec.taskId };
  });
}

async function reviewWith(
  files: Record<string, string>,
  rt: ReturnType<typeof runtime>,
  prior?: PriorFinding[],
) {
  const adapter = vcs(files, twoFiles);
  if (prior) adapter.getPriorReview = async () => ({ findings: prior });
  return review({ vcs: adapter, runtime: rt, stages: { verify: false, judge: false } });
}

describe("review against the previous review", () => {
  it("compares with the previous review and survives failing to load it", async () => {
    const rt = runtime(async function* (spec) {
      yield { type: "finding", taskId: spec.taskId, finding: finding("src/a.ts", "const a = 1;") };
      yield { type: "done", taskId: spec.taskId };
    });
    const first = await review({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      stages: { verify: false, judge: false },
    });
    const fingerprint = first.findings[0]?.fingerprint ?? "";
    const old = { title: "t", severity: "warning" as const, commented: true };

    // src/b.ts still exists; the code the earlier finding quoted does not.
    const withPrior = vcs(head, twoFiles);
    const removed = quoteSignature("const removed = 1;\n", { start: 1, end: 1 });
    withPrior.getPriorReview = async () => ({
      findings: [
        { ...old, fingerprint, file: "src/a.ts" },
        { ...old, fingerprint: "gone", file: "src/b.ts", ...(removed ? { quote: removed } : {}) },
      ],
    });
    const second = await review({
      vcs: withPrior,
      runtime: rt,
      stages: { verify: false, judge: false },
    });
    expect(second.findings[0]?.status).toBe("unfixed");
    expect(second.rereview?.fixed.map((f) => f.fingerprint)).toEqual(["gone"]);

    const broken = vcs({}, twoFiles);
    broken.getPriorReview = async () => {
      throw new Error("HTTP 502");
    };
    const third = await review({
      vcs: broken,
      runtime: rt,
      stages: { verify: false, judge: false },
    });
    expect(third.findings).toHaveLength(1);
    expect(third.rereview).toBeUndefined();
    expect(third.warnings).toContain("could not load the previous review: HTTP 502");
  });

  it("stays quiet about findings in the repository's memory and tells reviewers", async () => {
    const rt = runtime(async function* (spec) {
      yield { type: "finding", taskId: spec.taskId, finding: finding("src/a.ts", "const a = 1;") };
      yield { type: "done", taskId: spec.taskId };
    });
    const first = await review({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      stages: { verify: false, judge: false },
    });
    const entry = {
      fingerprint: first.findings[0]?.fingerprint ?? "",
      file: "src/a.ts",
      title: "t",
      reason: "known and accepted",
    };
    const memory = JSON.stringify({ accepted: [entry] });
    const second = await review({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      readTrusted: async (p) => (p === ".ocra/memory.json" ? memory : undefined),
      stages: { verify: false, judge: false },
    });
    expect(second.findings).toEqual([]);
    expect(second.remembered).toEqual([{ ...entry, source: "repository" }]);
    expect(rt.specs.at(-1)?.userPrompt).toContain("- src/a.ts: t (accepted: known and accepted)");
  });

  it("applies the account's memory with the repository's, the repository's first", async () => {
    const rt = reporting(finding("src/a.ts", "const a = 1;"), finding("src/b.ts", "const b = 2;"));
    const opts = { vcs: vcs({}, twoFiles), runtime: rt, verify: false, judge: false } as const;
    const first = await review(opts);
    const fp = (file: string) => first.findings.find((f) => f.file === file)?.fingerprint ?? "";
    expect(fp("src/a.ts")).not.toBe(fp("src/b.ts"));
    const inRepo = { fingerprint: fp("src/a.ts"), file: "src/a.ts", title: "t", reason: "ours" };
    const memory = JSON.stringify({ accepted: [inRepo] });
    const second = await review({
      ...opts,
      readTrusted: async (p) => (p === ".ocra/memory.json" ? memory : undefined),
      accountMemory: [
        { ...inRepo, reason: "also the account's" },
        { fingerprint: fp("src/b.ts"), file: "src/b.ts", title: "t", reason: "mine" },
      ],
    });
    expect(second.findings).toEqual([]);
    expect(second.remembered).toEqual(
      expect.arrayContaining([
        { ...inRepo, source: "repository" },
        {
          fingerprint: fp("src/b.ts"),
          file: "src/b.ts",
          title: "t",
          reason: "mine",
          source: "account",
        },
      ]),
    );
    expect(second.remembered).toHaveLength(2);
    expect(rt.specs.map((s) => s.userPrompt).join("\n")).toContain(
      "- src/b.ts: t (accepted: mine)",
    );
  });

  it("keeps the verdict when a finding is not reported again but its code is unchanged", async () => {
    const critical = finding("src/a.ts", "const a = 1;", { severity: "critical" });
    const first = await reviewWith(head, reporting(critical));
    // Verification is off in these runs: the critical finding is unchecked.
    expect(first.verdict).toBe("minor_issues");
    expect(first.findings[0]?.quote).toMatchObject({ lines: 1 });
    const unchanged = await reviewWith(head, reporting(), asPrior(first));
    expect(unchanged.verdict).toBe("minor_issues");

    // An earlier finding keeps the verification it had.
    const verified = asPrior(first).map((f) => ({ ...f, verification: "confirmed" as const }));
    const second = await reviewWith(head, reporting(), verified);
    expect(second.findings).toEqual([]);
    expect(second.rereview?.fixed).toEqual([]);
    expect(second.rereview?.notReproduced.map((f) => f.fingerprint)).toEqual([
      first.findings[0]?.fingerprint,
    ]);
    expect(second.verdict).toBe("significant_concerns");
  });

  it("does not take another quote or category for a fix", async () => {
    const first = await reviewWith(head, reporting(finding("src/a.ts", "const a = 1;")));
    const requoted = finding("src/a.ts", "keep", { category: "style" });
    const second = await reviewWith(head, reporting(requoted), asPrior(first));
    expect(second.findings[0]?.category).toBe("correctness");
    expect(second.findings[0]?.status).toBe("new");
    expect(second.rereview?.fixed).toEqual([]);
    expect(second.rereview?.notReproduced).toHaveLength(1);
  });

  it("ignores the category a model sends, so the fingerprint stays the same", async () => {
    const first = await reviewWith(head, reporting(finding("src/a.ts", "const a = 1;")));
    const relabelled = finding("src/a.ts", "const a = 1;", { category: "bug" });
    const second = await reviewWith(head, reporting(relabelled), asPrior(first));
    expect(second.findings[0]?.fingerprint).toBe(first.findings[0]?.fingerprint);
    expect(second.findings[0]?.status).toBe("unfixed");
  });

  it("judges a finding fixed once its code or its file is gone", async () => {
    const first = await reviewWith(
      head,
      reporting(
        finding("src/a.ts", "const a = 1;", { severity: "critical" }),
        finding("src/b.ts", "const b = 2;"),
      ),
    );
    const changed = { "src/a.ts": "keep\nconst a = 2;\n" };
    const second = await reviewWith(changed, reporting(), asPrior(first));
    expect(second.rereview?.fixed.map((f) => f.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(second.verdict).toBe("approved");
  });

  it("never resolves earlier findings stored without a code signature", async () => {
    const legacy = asPrior(await reviewWith(head, reporting(finding("src/a.ts", "const a = 1;"))));
    const withoutQuote = legacy.map(({ quote: _quote, ...rest }) => rest);
    const second = await reviewWith({ "src/a.ts": "changed\n" }, reporting(), withoutQuote);
    expect(second.rereview?.fixed).toEqual([]);
    expect(second.rereview?.notReproduced).toHaveLength(1);
    expect(second.verdict).toBe("approved_with_comments");
  });

  it("reviews unchanged files again when the risk tier rose since the earlier review", async () => {
    const diff = [
      patch("src/auth/session.ts", "const a = 1;"),
      patch("src/b.ts", "const b = 2;"),
    ].join("\n");
    const since = async (tier: "trivial" | "full") => {
      const adapter = vcs({}, diff);
      adapter.getPriorReview = async () => ({
        findings: [],
        changedSince: { head: "h0", files: ["src/b.ts"] },
        tier,
      });
      return review({
        vcs: adapter,
        runtime: reporting(),
        stages: { verify: false, judge: false },
      });
    };
    // The auth path makes this change "full"; the earlier review ran at "trivial".
    const risen = await since("trivial");
    expect(risen.tier).toBe("full");
    expect(risen.scope).toEqual({
      mode: "full",
      reason: "the risk tier rose from trivial to full, which adds reviewers",
    });
    expect(risen.coverage.map((c) => c.status)).toEqual(["reviewed", "reviewed"]);

    const same = await since("full");
    expect(same.scope).toEqual({ mode: "incremental", since: "h0" });
    expect(same.coverage.map((c) => [c.path, c.status])).toEqual([
      ["src/auth/session.ts", "unchanged"],
      ["src/b.ts", "reviewed"],
    ]);
  });

  it("shows the judge people's replies to a finding reported again", async () => {
    const reporting = runtime(async function* (spec) {
      yield {
        type: "finding",
        taskId: spec.taskId,
        finding: finding("src/a.ts", "const a = 1;", { severity: "warning" }),
      };
      yield { type: "done", taskId: spec.taskId };
    });
    const first = await review({
      vcs: vcs(head, twoFiles),
      runtime: reporting,
      stages: { verify: false },
    });
    const fingerprint = first.findings[0]?.fingerprint ?? "";
    const judgePrompts: string[] = [];
    const judging = Object.assign(reporting, {
      complete: async (request: { system: string; user: string }) => {
        if (request.system.includes("judge")) judgePrompts.push(request.user);
        return { text: "{}", usage: first.usage };
      },
    });
    const adapter = vcs(head, twoFiles);
    adapter.getPriorReview = async () => ({
      findings: asPrior(first),
      replies: { [fingerprint]: ["Handled by the caller in api.ts."] },
    });
    await review({
      vcs: adapter,
      runtime: judging,
      stages: { verify: false },
      mode: { full: true },
    });
    expect(judgePrompts).toHaveLength(1);
    expect(judgePrompts[0]).toContain(
      "<ocra_reply>\nHandled by the caller in api.ts.\n</ocra_reply>",
    );
  });
});
