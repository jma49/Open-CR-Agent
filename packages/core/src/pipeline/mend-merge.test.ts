import { describe, expect, it } from "vitest";
import type { CompletionRequest } from "../contracts.js";
import { braceSyntax, fixerRuntime, SOURCE } from "../fix/fix.fakes.js";
import type { MendLevel } from "../mend/outcomes.js";
import type { MendState } from "../mend/state.js";
import type { ChangeConflicts, CommitResult } from "../vcs.js";
import { answers, fakeVcs, HEAD, loop, SHA } from "./mend.fakes.js";
import { mendRound } from "./mend.js";
import { conflictItemId } from "./mend-conflicts.js";

const BASE_HEAD = "d".repeat(40);
const LINES = SOURCE.split("\n");
const OURS = "  let sum = 0; // cents";
const THEIRS = "  let total = 0;";
const MERGED = [
  ...LINES.slice(0, 5),
  "<<<<<<< ours",
  OURS,
  "||||||| base",
  "  let sum = 0;",
  "=======",
  THEIRS,
  ">>>>>>> theirs",
  ...LINES.slice(6),
].join("\n");
const RESOLVED = "  let total = 0; // cents";
const file = { path: "src/a.ts", merged: MERGED, markerSize: 7, executable: false };
const id = conflictItemId(file);
const conflicts: ChangeConflicts = { mergeParent: BASE_HEAD, files: [file], other: [] };

const resolves =
  (lines = RESOLVED, verdict = "resolves") =>
  (request: CompletionRequest) =>
    request.agent === "verifier"
      ? JSON.stringify({ verdict })
      : JSON.stringify({ resolved: true, regions: [{ region: 1, lines }] });

async function round(
  options: {
    conflicts?: ChangeConflicts | undefined;
    answer?: (request: CompletionRequest) => string;
    level?: MendLevel;
    state?: MendState;
    commit?: () => Promise<CommitResult>;
    findings?: (typeof loop)[];
  } = {},
) {
  const runtime = fixerRuntime(options.answer ?? resolves());
  const { vcs, commits, notes } = fakeVcs(options.commit);
  vcs.conflicts = async () => ("conflicts" in options ? options.conflicts : conflicts);
  const result = await mendRound({
    findings: options.findings ?? [],
    conflicts: true,
    vcs,
    runtime,
    syntax: braceSyntax,
    level: options.level ?? "commit",
    ...(options.state ? { state: options.state } : {}),
    signal: new AbortController().signal,
    onUsage: () => {},
  });
  return { result, commits, notes, requests: runtime.requests };
}

describe("mendRound over merge conflicts", () => {
  it("answers each conflicted file, checks it and commits the merge with both parents", async () => {
    const { result, commits, notes, requests } = await round();
    expect(result).toMatchObject({ outcome: "committed", sha: SHA, mergeParent: BASE_HEAD });
    expect(result.items).toEqual([{ id, conflict: "src/a.ts", outcome: "fixed" }]);
    expect(requests.map((r) => r.agent)).toEqual(["fixer", "verifier"]);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ parent: HEAD, mergeParent: BASE_HEAD });
    expect(commits[0]?.files).toEqual([
      {
        path: "src/a.ts",
        content: MERGED.split("\n")
          .filter((line) => !/^[<|=>]{7}/.test(line) && line !== OURS && line !== "  let sum = 0;")
          .join("\n")
          .replace(THEIRS, RESOLVED),
        created: false,
        executable: false,
      },
    ]);
    expect(commits[0]?.message.split("\n")[0]).toBe(
      "Merge dddddddddddd of the base branch, conflicts resolved by ocra",
    );
    expect(notes[0]?.merge).toBe(true);
    expect(notes[0]?.fixed).toEqual([{ title: "merge conflict", file: "src/a.ts" }]);
    expect(result.state.items).toEqual({ [id]: { attempts: 1 } });
  });

  it("shows the regions as data and the resolution to the verifier", async () => {
    const { requests } = await round();
    expect(requests[0]?.user).toContain(`<ocra_pull_request>\n${OURS}\n</ocra_pull_request>`);
    expect(requests[1]?.user).toContain(`<ocra_replacement>\n${RESOLVED}\n</ocra_replacement>`);
  });

  it("proposes the resolved file without a commit at the propose level", async () => {
    const { result, commits } = await round({ level: "propose" });
    expect(result.outcome).toBe("proposed");
    expect(result.items[0]).toMatchObject({ id, conflict: "src/a.ts", outcome: "proposed" });
    expect(result.items[0]?.resolved).toContain(RESOLVED);
    expect(result.items[0]?.regions).toEqual([
      { line: 6, ours: [OURS], theirs: [THEIRS], lines: [RESOLVED] },
    ]);
    expect(result.items[0]?.resolved?.split("\n")[5]).toBe(RESOLVED);
    expect(commits).toEqual([]);
  });

  it("works on the conflicts alone: findings wait for the next round without an attempt", async () => {
    const { result, requests } = await round({ findings: [loop] });
    expect(result.items).toEqual([
      { id, conflict: "src/a.ts", outcome: "fixed" },
      { id: "loop", outcome: "deferred", reason: "conflicts" },
    ]);
    expect(requests).toHaveLength(2);
    expect(result.state.items).toEqual({ [id]: { attempts: 1 } });
  });

  it("commits nothing when the verifier does not confirm, or the answer is not a merge", async () => {
    const unsure = await round({ answer: resolves(RESOLVED, "unsure") });
    expect(unsure.result.outcome).toBe("nothing");
    expect(unsure.result.items).toEqual([
      { id, conflict: "src/a.ts", outcome: "rejected", reason: "unsure" },
    ]);
    const marked = await round({ answer: resolves("<<<<<<< x\n  let total = 0;") });
    expect(marked.result.items[0]).toMatchObject({ reason: "failed", cause: "invalid_output" });
    const broken = await round({ answer: resolves("  let total = 0; }") });
    expect(broken.result.items[0]).toMatchObject({ outcome: "rejected", reason: "syntax" });
    const declined = await round({ answer: () => '{"resolved": false}' });
    expect(declined.result.items[0]).toMatchObject({ outcome: "rejected", reason: "declined" });
    expect([unsure, marked, broken, declined].flatMap((r) => r.commits)).toEqual([]);
  });

  it("asks no model when a conflict is not the lane's, and leaves the rest waiting", async () => {
    const mixed = await round({
      conflicts: { ...conflicts, other: ["logo.png"] },
    });
    expect(mixed.result.outcome).toBe("nothing");
    expect(mixed.result.items).toEqual([
      {
        id: conflictItemId({ path: "logo.png" }),
        conflict: "logo.png",
        outcome: "needs_human",
        reason: "not_candidate",
      },
      { id, conflict: "src/a.ts", outcome: "deferred", reason: "conflicts" },
    ]);
    const guarded = { ...file, path: ".github/scripts/a.ts" };
    const protectedFile = await round({ conflicts: { ...conflicts, files: [guarded] } });
    expect(protectedFile.result.items[0]).toMatchObject({
      outcome: "needs_human",
      reason: "protected",
    });
    expect([...mixed.requests, ...protectedFile.requests]).toEqual([]);
  });

  it("gives a conflict two attempts, and counts none when the branch moved", async () => {
    const used = await round({
      state: { rounds: 2, costUsd: 0, items: { [id]: { attempts: 2 } } },
    });
    expect(used.result.items).toEqual([
      { id, conflict: "src/a.ts", outcome: "needs_human", reason: "attempts" },
    ]);
    expect(used.requests).toEqual([]);
    const moved = await round({
      commit: async () => ({ committed: false, outcome: "head_moved", reason: "moved" }),
    });
    expect(moved.result.outcome).toBe("head_moved");
    expect(moved.result.items).toEqual([
      { id, conflict: "src/a.ts", outcome: "deferred", reason: "head_moved" },
    ]);
    expect(moved.result.state.items).toEqual({});
  });

  it("runs the usual round when the change merges cleanly", async () => {
    const { result, commits } = await round({
      conflicts: undefined,
      findings: [loop],
      answer: answers(),
    });
    expect(result.outcome).toBe("committed");
    expect(result.mergeParent).toBeUndefined();
    expect(commits[0]?.mergeParent).toBeUndefined();
  });
});
