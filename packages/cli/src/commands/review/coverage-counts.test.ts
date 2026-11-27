import type { ReviewReport } from "@open-cr-agent/core";
import { renderSummary } from "@open-cr-agent/vcs-platform/internal";
import { expect, it } from "vitest";
import { uploadOf } from "../../cloud/upload.js";
import { exitCode } from "./exit-code.js";
import { renderText } from "./render.js";
import { base } from "./report.fakes.js";

it("separates missed files from partly reviewed files without changing the upload total", () => {
  const report: ReviewReport = {
    ...base,
    coverage: [
      ...base.coverage,
      { path: "failed.ts", status: "failed" },
      { path: "skipped.ts", status: "unreviewed" },
      { path: "long.ts", status: "incomplete", ended: "step_cap" },
      { path: "big.ts", status: "incomplete", ended: "context_window" },
      { path: "early.ts", status: "incomplete", ended: "stopped_early" },
      { path: "previous.ts", status: "unchanged" },
    ],
  };
  const text = renderText(report);
  expect(text).toContain("Incomplete: 2 selected file(s) were not reviewed.");
  const errors: string[] = [];
  expect(exitCode(report, { write: (line) => errors.push(line) })).toBe(3);
  expect(errors).toContain(
    "[ocra] 2 selected file(s) were not reviewed; the review is incomplete.\n",
  );
  const summary = renderSummary({
    report,
    commented: new Set(),
    state: { findings: [] },
    text: { changeRequest: "pull request", authority: "write access" },
  });
  expect(summary).toContain("**Incomplete:** 2 selected file(s) were not reviewed.");
  expect(summary).toContain(
    "3 partly reviewed · 1 unchanged since the last review · 2 not reviewed",
  );
  expect(uploadOf(report, "local", "f".repeat(64), 1).files.notReviewed).toBe(5);
});
