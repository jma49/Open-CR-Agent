import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixResultSchema } from "@open-cr-agent/cloud-contract";
import type { CompletionRequest, OcraPlugin } from "@open-cr-agent/core";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps } from "../run.fakes.js";
import { run } from "../run.js";

const repos = scratchRepos("ocra-fix-");
afterEach(repos.removeAll);

const LOOP = "  for (let i = 0; i <= prices.length; i++) sum += prices[i];";
const FIXED = "  for (let i = 0; i < prices.length; i++) sum += prices[i];";
const before = (loop: string) =>
  [
    "export function total(prices: number[]) {",
    "  let sum = 0;",
    loop,
    "  return sum;",
    "}",
    "",
  ].join("\n");

function fixer(seen: CompletionRequest[], answer: unknown): OcraPlugin {
  return {
    name: "runtime-opencode",
    configure(ctx) {
      ctx.registerRuntime("opencode", () => ({
        name: "fake",
        runTask: () => {
          throw new Error("ocra fix runs no review task");
        },
        complete: async (request) => {
          seen.push(request);
          return {
            text: JSON.stringify(answer),
            usage: {
              inputTokens: 40,
              outputTokens: 20,
              reasoningTokens: 0,
              cachedTokens: 0,
              costUsd: 0.03,
            },
          };
        },
      }));
    },
  };
}

// A commit that brings the off-by-one in; the finding quotes it.
function repository() {
  const repo = repos.create();
  repo.commit("init", { "src/total.ts": before(FIXED) });
  const head = repo.commit("count prices", { "src/total.ts": before(LOOP) });
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

async function fix(
  cwd: string,
  args: string[],
  input: unknown = finding,
  answer: unknown = [{ index: 0, replacement: FIXED }],
) {
  const seen: CompletionRequest[] = [];
  const out = capture();
  const err = capture();
  const file = join(cwd, ".git", "finding.json");
  writeFileSync(file, typeof input === "string" ? input : JSON.stringify(input));
  const code = await run(
    ["fix", ...args.map((a) => (a === "@finding" ? file : a))],
    out,
    err,
    deps(cwd, async function* () {}, {
      runtimes: { opencode: async () => fixer(seen, answer) },
      readStdin: async () => JSON.stringify(input),
    }),
  );
  return { code, seen, out: out.text(), err: err.text() };
}

const status = (cwd: string) =>
  execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });

describe("ocra fix", () => {
  it("prints a checked fix for one stored finding and commits nothing", async () => {
    const { dir, head } = repository();
    const result = await fix(dir, ["--commit", head, "--finding", "@finding", "--json"]);
    expect(result.code).toBe(0);
    expect(result.seen.map((r) => r.agent)).toEqual(["fixer"]);
    expect(fixResultSchema.parse(JSON.parse(result.out))).toEqual({
      fingerprint: finding.fingerprint,
      headSha: head,
      outcome: "proposed",
      fix: { startLine: 3, endLine: 3, replacement: FIXED },
      reason: null,
      usage: {
        inputTokens: 40,
        cachedTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        costUsd: 0.03,
      },
    });
    expect(result.err).toContain("[ocra] Fix for src/total.ts:3-3; $0.0300");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()).toBe(
      head,
    );
    expect(status(dir)).toBe("");
  });

  it("reads the finding from stdin and writes nothing when the head moved", async () => {
    const { dir, head } = repository();
    const other = "e".repeat(40);
    const result = await fix(dir, [
      "--from",
      `${head}~1`,
      "--finding",
      "-",
      "--head",
      other,
      "--json",
    ]);
    expect(result.code).toBe(3);
    expect(result.seen).toEqual([]);
    expect(JSON.parse(result.out)).toMatchObject({
      outcome: "head_moved",
      fix: null,
      reason: null,
    });
  });

  it("exits 3 when the finding's code is gone, and 0 with the reason when no fix was kept", async () => {
    const { dir, head } = repository();
    const gone = await fix(dir, ["--commit", head, "--finding", "@finding", "--json"], {
      ...finding,
      code: "sum += prices[i] * 2;",
    });
    expect(gone.code).toBe(3);
    expect(JSON.parse(gone.out)).toMatchObject({ outcome: "stale", reason: "stale" });
    expect(gone.seen).toEqual([]);
    const declined = await fix(
      dir,
      ["--commit", head, "--finding", "@finding", "--json"],
      finding,
      [{ index: 0, replacement: null }],
    );
    expect(declined.code).toBe(0);
    expect(JSON.parse(declined.out)).toMatchObject({ outcome: "not_fixable", reason: "declined" });
  });

  it("refuses a finding that is not one, and a run with no change named", async () => {
    const { dir, head } = repository();
    const bad = await fix(dir, ["--commit", head, "--finding", "@finding"], { title: "x" });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("ocra [INPUT_INVALID]: --finding is not a finding: fingerprint");
    const notJson = await fix(dir, ["--commit", head, "--finding", "@finding"], "{");
    expect(notJson.err).toContain("--finding is not JSON");
    const none = await fix(dir, ["--finding", "@finding"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("ocra fix needs --pr, --mr, --from or --commit");
    expect(bad.seen).toEqual([]);
  });
});
