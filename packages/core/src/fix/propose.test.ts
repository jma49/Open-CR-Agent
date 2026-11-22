import { describe, expect, it } from "vitest";
import { spendLimit } from "../agent/spend-limit.js";
import type { FileDiff } from "../domain.js";
import { anchored, braceSyntax, contextOf, fixerRuntime, SOURCE, usage } from "./fix.fakes.js";
import { proposeFixes } from "./propose.js";

const fixedLoop = "  for (let i = 0; i < prices.length; i++) sum += prices[i];";
const diffs = [{ newPath: "src/a.ts", patch: "@@ -1 +1,9 @@" }] as FileDiff[];
const base = {
  syntax: braceSyntax,
  diffs,
  context: contextOf({ "src/a.ts": SOURCE }),
  signal: new AbortController().signal,
  concurrency: 2,
  maxFixes: 10,
};

describe("proposeFixes", () => {
  it("asks the fixer once per file, most severe first, and keeps the fixes that pass the checks", async () => {
    const runtime = fixerRuntime(() =>
      JSON.stringify([
        { index: 0, replacement: fixedLoop },
        { index: 1, replacement: "  return items[0]?.trim();" },
        { index: 1, replacement: "ignored: the first answer wins" },
      ]),
    );
    const findings = [anchored(2, 2), anchored(7, 7, { severity: "critical" })];
    const result = await proposeFixes(findings, { ...base, runtime });
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.agent).toBe("fixer");
    expect(runtime.requests[0]?.user).toContain('<ocra_lines_to_replace start="7" end="7">');
    expect(result.findings.map((f) => f.fix)).toEqual([
      { startLine: 2, endLine: 2, replacement: "  return items[0]?.trim();" },
      { startLine: 7, endLine: 7, replacement: fixedLoop },
    ]);
    expect(result.summary).toEqual({ asked: 2, proposed: 2, rejected: [] });
    expect(result.usage).toHaveLength(1);
  });

  it("records why a fix was not kept, and leaves the finding as it was", async () => {
    const runtime = fixerRuntime(() =>
      JSON.stringify([
        { index: 0, replacement: null },
        { index: 1, replacement: "  for (;;) {" },
      ]),
    );
    const findings = [anchored(7, 7, { severity: "critical" }), anchored(2, 2)];
    const result = await proposeFixes(findings, { ...base, runtime });
    expect(result.findings).toEqual(findings);
    expect(result.summary.rejected).toEqual([
      { fingerprint: "fp-7", reason: "declined" },
      { fingerprint: "fp-2", reason: "syntax" },
    ]);
  });

  it("keeps the findings when the fixer fails or answers nonsense", async () => {
    for (const answer of [
      () => "not json",
      () => {
        throw new Error("boom");
      },
    ]) {
      const runtime = fixerRuntime(answer);
      const findings = [anchored(7, 7)];
      const result = await proposeFixes(findings, { ...base, runtime });
      expect(result.findings).toEqual(findings);
      expect(result.summary.rejected).toEqual([{ fingerprint: "fp-7", reason: "failed" }]);
      expect(result.warnings[0]).toMatch(/proposing fixes for src\/a.ts failed/);
    }
  });

  it("makes no call for a file it could not check a fix in", async () => {
    const runtime = fixerRuntime(() => "[]");
    const finding = anchored(7, 7, { file: "src/a.rb" });
    const result = await proposeFixes([finding], {
      ...base,
      context: contextOf({ "src/a.rb": SOURCE }),
      runtime,
    });
    expect(runtime.requests).toEqual([]);
    expect(result.summary).toEqual({
      asked: 0,
      proposed: 0,
      rejected: [{ fingerprint: "fp-7", reason: "no_parser" }],
    });
  });

  it("asks for at most maxFixes, and none once the spend limit is used up", async () => {
    const runtime = fixerRuntime(() => "[]");
    const findings = [anchored(2, 2), anchored(7, 7)];
    const capped = await proposeFixes(findings, { ...base, runtime, maxFixes: 1 });
    expect(capped.summary.asked).toBe(1);

    const spent = spendLimit(0.01, [{ ...usage, costUsd: 0.02 }]);
    const broke = fixerRuntime(() => "[]");
    const result = await proposeFixes(findings, { ...base, runtime: broke, spendLimit: spent });
    expect(broke.requests).toEqual([]);
    expect(result.warnings).toEqual(["spend limit reached: no fix was proposed for 2 finding(s)"]);
  });

  it("makes no call for findings it may not fix", async () => {
    const runtime = fixerRuntime(() => "[]");
    const relocated = anchored(7, 7, { anchor: { method: "relocated", inDiff: true } });
    const result = await proposeFixes([relocated], { ...base, runtime });
    expect(runtime.requests).toEqual([]);
    expect(result.summary).toEqual({ asked: 0, proposed: 0, rejected: [] });
  });
});
