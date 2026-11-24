import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mendResultSchema } from "@open-cr-agent/cloud-contract";
import type { CompletionRequest, OcraPlugin } from "@open-cr-agent/core";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps } from "../run.fakes.js";
import { run } from "../run.js";

const repos = scratchRepos("ocra-mend-");
afterEach(repos.removeAll);

const LOOP = "  for (let i = 0; i <= prices.length; i++) sum += prices[i];";
const FIXED = "  for (let i = 0; i < prices.length; i++) sum += prices[i];";
const source = (loop: string) =>
  [
    "export function total(prices: number[]) {",
    "  let sum = 0;",
    loop,
    "  return sum;",
    "}",
    "",
  ].join("\n");

const USAGE = { inputTokens: 40, outputTokens: 20, reasoningTokens: 0, cachedTokens: 0 };

function models(seen: CompletionRequest[], verdict: string): OcraPlugin {
  return {
    name: "runtime-opencode",
    configure(ctx) {
      ctx.registerRuntime("opencode", () => ({
        name: "fake",
        runTask: () => {
          throw new Error("ocra mend runs no review task");
        },
        complete: async (request) => {
          seen.push(request);
          const answer =
            request.agent === "verifier" ? { verdict } : [{ index: 0, replacement: FIXED }];
          return { text: JSON.stringify(answer), usage: { ...USAGE, costUsd: 0.03 } };
        },
      }));
    },
  };
}

// A commit that brings the off-by-one in, and a workflow no round may edit.
function repository() {
  const repo = repos.create();
  repo.commit("init", { "src/total.ts": source(FIXED) });
  const head = repo.commit("count prices", {
    "src/total.ts": source(LOOP),
    ".github/scripts/total.ts": source(LOOP),
  });
  return { dir: repo.dir, head };
}

const finding = {
  fingerprint: "b491fb26b470419c",
  reviewer: "correctness",
  severity: "warning",
  category: "correctness",
  verification: "confirmed",
  file: "src/total.ts",
  lineStart: 3,
  lineEnd: 3,
  title: "Reads past the end",
  body: "The loop reads prices[prices.length].",
  suggestion: null,
  code: LOOP.trim(),
};
const inWorkflow = {
  ...finding,
  fingerprint: "0c1d2e3f4a5b6c7d",
  file: ".github/scripts/total.ts",
};

async function mend(
  cwd: string,
  args: string[],
  options: { findings?: unknown; state?: unknown; verdict?: string } = {},
) {
  const seen: CompletionRequest[] = [];
  const out = capture();
  const err = capture();
  const input = JSON.stringify(options.findings ?? [finding]);
  const findings = join(cwd, ".git", "findings.json");
  const state = join(cwd, ".git", "mend-state.json");
  writeFileSync(findings, input);
  writeFileSync(state, JSON.stringify(options.state ?? {}));
  const named: Record<string, string> = { "@findings": findings, "@state": state };
  const code = await run(
    ["mend", ...args.map((a) => named[a] ?? a)],
    out,
    err,
    deps(cwd, async function* () {}, {
      runtimes: { opencode: async () => models(seen, options.verdict ?? "resolves") },
      readStdin: async () => input,
    }),
  );
  return { code, seen, out: out.text(), err: err.text() };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("ocra mend", () => {
  it("proposes the checked fix of an accepted finding and commits nothing", async () => {
    const { dir, head } = repository();
    const result = await mend(dir, ["--commit", head, "--findings", "@findings", "--json"]);
    expect(result.code).toBe(0);
    expect(result.seen.map((r) => r.agent)).toEqual(["fixer", "verifier"]);
    expect(mendResultSchema.parse(JSON.parse(result.out))).toEqual({
      headSha: head,
      outcome: "proposed",
      stopped: null,
      commitSha: null,
      mergeParent: null,
      items: [
        {
          fingerprint: finding.fingerprint,
          check: null,
          conflict: null,
          resolved: null,
          regions: [],
          outcome: "proposed",
          reason: null,
          cause: null,
          edits: [{ path: "src/total.ts", startLine: 3, endLine: 3, replacement: FIXED }],
        },
      ],
      state: { rounds: 1, costUsd: 0.06, items: { [finding.fingerprint]: { attempts: 1 } } },
      usage: { ...USAGE, inputTokens: 80, outputTokens: 40, costUsd: 0.06 },
    });
    expect(result.err).toContain("[ocra] Proposed fixes for 1 finding, nothing committed; $0.0600");
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("hands a protected file and a refused fix to a person or the next round", async () => {
    const { dir, head } = repository();
    const args = ["--from", `${head}~1`, "--findings", "-"];
    const result = await mend(dir, args, {
      findings: [inWorkflow, finding],
      verdict: "does_not_resolve",
    });
    expect(result.code).toBe(0);
    expect(result.out.split("\n").filter(Boolean)).toEqual([
      `needs_human (protected)  .github/scripts/total.ts  ${inWorkflow.fingerprint}`,
      `rejected (unresolved)  src/total.ts  ${finding.fingerprint}`,
    ]);
    expect(result.err).toContain("[ocra] Nothing to commit for 2 findings");
    const own = await mend(dir, [...args, "--protect", "src/**", "--json"]);
    expect(JSON.parse(own.out).items).toMatchObject([
      { outcome: "needs_human", reason: "protected" },
    ]);
    expect(own.seen).toEqual([]);
  });

  it("stops by the state it is given, and exits 3 when it cannot write or the head moved", async () => {
    const { dir, head } = repository();
    const base = ["--commit", head, "--findings", "@findings", "--json"];
    const spent = { rounds: 6, costUsd: 1, items: {} };
    const stopped = await mend(dir, [...base, "--state", "@state"], { state: spent });
    expect(stopped.code).toBe(0);
    expect(JSON.parse(stopped.out)).toMatchObject({
      outcome: "stopped",
      stopped: "rounds",
      state: spent,
    });
    const local = await mend(dir, [...base, "--level", "commit"]);
    expect(local.code).toBe(3);
    expect(JSON.parse(local.out)).toMatchObject({ outcome: "not_writable", items: [] });
    const moved = await mend(dir, [...base, "--head", "e".repeat(40)]);
    expect(moved.code).toBe(3);
    expect(JSON.parse(moved.out)).toMatchObject({ outcome: "head_moved" });
    expect([...stopped.seen, ...local.seen, ...moved.seen]).toEqual([]);
  });

  it("refuses input that is not what it reads", async () => {
    const { dir, head } = repository();
    const base = ["--commit", head, "--findings", "@findings"];
    const one = await mend(dir, base, { findings: finding });
    expect(one.code).toBe(2);
    expect(one.err).toContain("ocra [INPUT_INVALID]: --findings is not a list of findings");
    const state = await mend(dir, [...base, "--state", "@state"], { state: { rounds: "two" } });
    expect(state.err).toContain("--state is not a state ocra mend printed: rounds");
    const level = await mend(dir, [...base, "--level", "merge"]);
    expect(level.err).toContain("--level must be one of propose, commit");
    const none = await mend(dir, ["--findings", "@findings"]);
    expect(none.err).toContain("ocra mend needs --pr, --mr, --from or --commit");
    const neither = await mend(dir, ["--commit", head]);
    expect(neither.err).toContain("ocra mend needs --findings <file|->, --checks or --conflicts");
    const local = await mend(dir, ["--commit", head, "--checks"]);
    expect(local.err).toContain("--checks and --conflicts need --pr or --mr");
    expect([one, state, level, none, neither, local].map((r) => r.code)).toEqual([
      2, 2, 2, 2, 2, 2,
    ]);
  });
});
