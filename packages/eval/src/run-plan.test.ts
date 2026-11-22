import { describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { renderPlan, spendBound } from "./run-plan.js";

const plan = { label: "l", dataset: "golden", ids: ["a", "b"], repeat: 3, models: {} };

describe("spendBound", () => {
  it("is the per-PR cap times every review, under the run's cap", () => {
    expect(spendBound(plan)).toBeUndefined();
    expect(spendBound({ ...plan, prMaxCostUsd: 0.5 })).toBe(3);
    expect(spendBound({ ...plan, prMaxCostUsd: 0.5, maxCostUsd: 2 })).toBe(2);
    expect(spendBound({ ...plan, maxCostUsd: 2 })).toBe(2);
  });
});

describe("renderPlan", () => {
  it("asks for a cap when there is none", () => {
    expect(renderPlan(plan)).toContain("Spend bound: none");
  });
});

describe("ocra-eval run --dry-run", () => {
  it("prints the plan without a judge or a review", async () => {
    let text = "";
    const out = { write: (chunk: string) => (text += chunk) };
    const code = await main(
      [
        "run",
        "--dataset",
        "golden",
        "--tier",
        "smoke",
        "--repeat",
        "6",
        "--pr-max-cost-usd",
        "0.4",
        "--label",
        "smoke-baseline",
        "--dry-run",
      ],
      out,
      out,
      { OCRA_MODEL_TOP: "anthropic/claude-haiku-5-5" },
    );
    expect(code).toBe(0);
    expect(text).toContain("# Dry run smoke-baseline");
    expect(text).toMatch(/Would review (\d+) PR\(s\) of golden \(tier smoke\), 6 time\(s\)/);
    expect(text).toContain("top anthropic/claude-haiku-5-5, standard unset");
    expect(text).toContain("Judge: unset.");
    expect(text).not.toContain("Spend bound: none");
  });

  it("names the context an ablation run leaves out, and refuses one it does not know", async () => {
    let text = "";
    const out = { write: (chunk: string) => (text += chunk) };
    const args = ["run", "--dataset", "golden", "--tier", "smoke", "--dry-run", "--without"];
    expect(await main([...args, "learnings,callers"], out, out, {})).toBe(0);
    expect(text).toContain("Left out of every prompt: learnings, callers.");
    expect(await main([...args, "diff"], out, out, {})).not.toBe(0);
  });
});
