import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionRequest, OcraPlugin } from "@open-cr-agent/core";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps } from "../run.fakes.js";
import { run } from "../run.js";

const repos = scratchRepos("ocra-learn-");
afterEach(repos.removeAll);

const lesson = {
  title: "Release pooled connections on every exit path",
  body: "Every `pool.acquire()` needs a `release()` in a `finally`.",
  symbols: ["acquire"],
  keywords: ["connection pool"],
};

function repoWithFix() {
  const repo = repos.create();
  repo.commit("feat(db): query helper", {
    "src/db/query.ts":
      "export async function query(sql) {\n  const conn = await pool.acquire();\n  return conn.run(sql);\n}\n",
  });
  repo.commit("fix(db): release the connection when a query throws", {
    "src/db/query.ts":
      "export async function query(sql) {\n  const conn = await pool.acquire();\n  try {\n    return await conn.run(sql);\n  } finally {\n    conn.release();\n  }\n}\n",
  });
  repo.commit("docs: explain the pool", { "README.md": "pool\n" });
  return repo;
}

function withDrafts(cwd: string, seen: CompletionRequest[]) {
  const runtime: OcraPlugin = {
    name: "runtime-opencode",
    configure(ctx) {
      ctx.registerRuntime("opencode", () => ({
        name: "fake",
        runTask: () => {
          throw new Error("learn runs no review task");
        },
        complete: async (request) => {
          seen.push(request);
          return {
            text: JSON.stringify(lesson),
            usage: {
              inputTokens: 9,
              outputTokens: 3,
              reasoningTokens: 0,
              cachedTokens: 0,
              costUsd: 0.25,
            },
          };
        },
      }));
    },
  };
  return deps(cwd, async function* () {}, { runtimes: { opencode: async () => runtime } });
}

async function learn(cwd: string, seen: CompletionRequest[], ...args: string[]) {
  const out = capture();
  const err = capture();
  const code = await run(["learn", "mine", ...args], out, err, withDrafts(cwd, seen));
  return { code, out: out.text(), err: err.text() };
}

describe("ocra learn mine", () => {
  it("drafts a learning from each fix commit and writes it to the working tree", async () => {
    const repo = repoWithFix();
    const seen: CompletionRequest[] = [];
    const result = await learn(repo.dir, seen);
    expect(result.code).toBe(0);
    const path = ".ocra/learnings/release-pooled-connections-on-every-exit-path.md";
    expect(result.out).toBe(`${path}\n`);
    expect(result.err).toContain("1 learning(s) written from 1 draft(s); $0.2500");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.user).toContain("fix(db): release the connection when a query throws");
    const text = readFileSync(join(repo.dir, path), "utf8");
    expect(text).toContain("paths:\n  - src/db/**\n");
    expect(text).toContain(`ref: ${repo.git("rev-parse", "HEAD~1")}`);
    expect(readdirSync(join(repo.dir, ".ocra"))).toEqual(["learnings"]);
  });

  it("skips a fix a learning in the working tree already records", async () => {
    const repo = repoWithFix();
    await learn(repo.dir, []);
    const seen: CompletionRequest[] = [];
    const again = await learn(repo.dir, seen);
    expect(seen).toEqual([]);
    expect(again.out).toBe("");
    expect(again.err).toContain("1 already recorded");
  });

  it("drafts nothing once the spend limit is used up", async () => {
    const repo = repoWithFix();
    repo.commit("fix(api): handle an empty body", { "src/api/body.ts": "export const x = 1;\n" });
    const seen: CompletionRequest[] = [];
    const result = await learn(repo.dir, seen, "--max-cost-usd", "0.1");
    expect(seen).toHaveLength(1);
    expect(result.err).toContain("left by the spend limit");
  });

  it("refuses an unknown subcommand with the usage", async () => {
    const result = await learn(repos.create().dir, [], "--max", "0");
    expect(result.code).toBe(2);
    expect(result.err).toContain("--max must be a positive whole number");
    expect(result.err).toContain("Usage: ocra learn mine");
  });
});
