import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CachedJudge } from "./judge-cache.js";
import { UnusableJudgeAnswer } from "./judges.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-judge-"));
  dirs.push(dir);
  return join(dir, "cache.jsonl");
}

describe("CachedJudge", () => {
  it("answers repeated questions from the cache, written as each answer arrives", async () => {
    const path = cachePath();
    const inner = { sameIssue: vi.fn(async () => true) };
    const first = new CachedJudge(inner, path, "m");
    await first.load();
    await first.sameIssue("a", "b");
    await first.sameIssue("a", "b");
    expect(inner.sameIssue).toHaveBeenCalledTimes(1);
    expect(first.tally()).toEqual({ questions: 2, fromCache: 1, unusable: 0 });

    // No save step: a scoring that stops here has kept the answer.
    const second = new CachedJudge(inner, path, "m");
    await second.load();
    expect(await second.sameIssue("a", "b")).toBe(true);
    expect(inner.sameIssue).toHaveBeenCalledTimes(1);
  });

  it("never gives one judge's answers to another", async () => {
    const path = cachePath();
    const yes = { sameIssue: vi.fn(async () => true) };
    const first = new CachedJudge(yes, path, "old-model");
    await first.load();
    await first.sameIssue("a", "b");

    const no = { sameIssue: vi.fn(async () => false) };
    const second = new CachedJudge(no, path, "new-model");
    await second.load();
    expect(await second.sameIssue("a", "b")).toBe(false);
    expect(no.sameIssue).toHaveBeenCalledTimes(1);
  });

  it("asks again for a line a stopped scoring cut short", async () => {
    const path = cachePath();
    const inner = { sameIssue: vi.fn(async () => true) };
    const first = new CachedJudge(inner, path, "m");
    await first.sameIssue("a", "b");
    appendFileSync(path, '{"key":"abc","sa');

    const second = new CachedJudge(inner, path, "m");
    await second.load();
    await second.sameIssue("a", "b");
    await second.sameIssue("c", "d");
    expect(inner.sameIssue).toHaveBeenCalledTimes(2);
  });

  it("scores an unusable answer as no match without caching it, and fails past a small share", async () => {
    const path = cachePath();
    const inner = {
      sameIssue: vi.fn(async (reference: string) => {
        if (reference === "bad")
          throw new UnusableJudgeAnswer("No usable answer after asking twice: cut off");
        return true;
      }),
    };
    const judge = new CachedJudge(inner, path, "m");
    for (let i = 0; i < 50; i += 1) await judge.sameIssue(`ref ${i}`, "gen");
    expect(await judge.sameIssue("bad", "gen")).toBe(false);
    expect(judge.tally()).toEqual({ questions: 51, fromCache: 0, unusable: 1 });
    judge.checkAnswers();
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(50);

    await judge.sameIssue("bad", "gen");
    expect(inner.sameIssue).toHaveBeenCalledTimes(52);
    expect(() => judge.checkAnswers()).toThrow(
      /no usable answer to 2 of 52 questions.*First: No usable answer after asking twice: cut off/,
    );
  });

  it("lets any other failure of the judge fail scoring", async () => {
    const inner = {
      sameIssue: async () => {
        throw new Error("Judge request failed: HTTP 401");
      },
    };
    const judge = new CachedJudge(inner, cachePath(), "m");
    await expect(judge.sameIssue("a", "b")).rejects.toThrow("HTTP 401");
  });
});
