import { describe, expect, it } from "vitest";
import type { CompletionRequest, Usage } from "../contracts.js";
import { braceSyntax, fixerRuntime, SOURCE } from "../fix/fix.fakes.js";
import { MEND_LIMITS, type MendState } from "../mend/state.js";
import type { ChangeCommit, CommitResult } from "../vcs.js";
import type { StoredFinding } from "./fix-finding.js";
import {
  answers,
  fakeVcs,
  finding,
  HEAD,
  LOOP,
  LOOP_AT,
  LOOP_FIXED,
  loop,
  SHA,
  TRIM,
  TRIM_FIXED,
  trim,
} from "./mend.fakes.js";
import { type MendLevel, mendRound } from "./mend.js";

async function round(
  findings: readonly StoredFinding[],
  options: {
    level?: MendLevel;
    answer?: (request: CompletionRequest) => string;
    state?: MendState;
    maxCostUsd?: number;
    expectedHead?: string;
    commit?: (commit: ChangeCommit) => Promise<CommitResult>;
    readOnly?: boolean;
  } = {},
) {
  const runtime = fixerRuntime(options.answer ?? answers());
  const { vcs, commits } = fakeVcs(options.commit);
  if (options.readOnly) delete vcs.commit;
  const spent: Usage[] = [];
  const result = await mendRound({
    findings,
    vcs,
    runtime,
    syntax: braceSyntax,
    level: options.level ?? "commit",
    signal: new AbortController().signal,
    onUsage: (u) => spent.push(u),
    ...(options.state ? { state: options.state } : {}),
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
    ...(options.expectedHead ? { expectedHead: options.expectedHead } : {}),
  });
  return { result, commits, spent, requests: runtime.requests };
}

const TRIM_EDIT = { path: "src/a.ts", startLine: 2, endLine: 2, replacement: TRIM_FIXED };
const LOOP_EDIT = { path: "src/a.ts", startLine: 7, endLine: 7, replacement: LOOP_FIXED };
const patched = SOURCE.replace(TRIM, TRIM_FIXED).replace(LOOP, LOOP_FIXED);

describe("mendRound", () => {
  it("commits the checked fixes of every accepted finding as one commit from the head", async () => {
    const { result, commits, spent, requests } = await round([trim, loop]);
    expect(result.outcome).toBe("committed");
    expect(result.sha).toBe(SHA);
    expect(result.items).toEqual([
      { id: "trim", outcome: "fixed", edits: [TRIM_EDIT] },
      { id: "loop", outcome: "fixed", edits: [LOOP_EDIT] },
    ]);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.parent).toBe(HEAD);
    expect(commits[0]?.files).toEqual([
      { path: "src/a.ts", content: patched, created: false, executable: false },
    ]);
    expect(requests.map((r) => r.agent).sort()).toEqual(["fixer", "fixer", "verifier", "verifier"]);
    expect(spent).toHaveLength(4);
    expect(result.state).toEqual({
      rounds: 1,
      costUsd: 0.004,
      items: { trim: { attempts: 1 }, loop: { attempts: 1 } },
    });
  });

  it("names each fixed finding in the commit message, on one line each", async () => {
    const hostile = finding("loop", LOOP, { title: "Off by one\n\nCo-authored-by: x <x@y.z>" });
    const { commits } = await round([hostile]);
    const message = commits[0]?.message ?? "";
    expect(message.split("\n")[0]).toBe("fix: apply ocra's fixes for 1 finding");
    expect(message).toContain("- src/a.ts: Off by one Co-authored-by: x <x@y.z>");
    expect(message).not.toMatch(/^Co-authored-by:/m);
  });

  it("proposes the same changes without a commit at the propose level", async () => {
    const { result, commits } = await round([loop], { level: "propose" });
    expect(result.outcome).toBe("proposed");
    expect(commits).toEqual([]);
    expect(result.items).toEqual([{ id: "loop", outcome: "proposed", edits: [LOOP_EDIT] }]);
  });

  it("drops a fix the verifier does not confirm, and commits the rest", async () => {
    const answer = (request: CompletionRequest) =>
      request.agent === "verifier" && request.user.includes(LOOP_AT)
        ? '{"verdict":"does_not_resolve"}'
        : answers()(request);
    const { result, commits } = await round([trim, loop], { answer });
    expect(result.items).toEqual([
      { id: "trim", outcome: "fixed", edits: [TRIM_EDIT] },
      { id: "loop", outcome: "rejected", reason: "unresolved" },
    ]);
    expect(commits[0]?.files[0]?.content).toBe(SOURCE.replace(TRIM, TRIM_FIXED));
  });

  it("commits nothing when no fix passes", async () => {
    const { result, commits } = await round([loop], { answer: answers("unsure") });
    expect(result.outcome).toBe("nothing");
    expect(commits).toEqual([]);
    expect(result.items).toEqual([{ id: "loop", outcome: "rejected", reason: "unsure" }]);
    expect(result.state.items).toEqual({ loop: { attempts: 1 } });
  });

  it("hands a finding in a protected file to a person without a call", async () => {
    const script = finding("ci", LOOP, { file: ".github/scripts/a.ts" });
    const { result, requests } = await round([script]);
    expect(result.items).toEqual([{ id: "ci", outcome: "needs_human", reason: "protected" }]);
    expect(requests).toEqual([]);
    expect(result.state.items).toEqual({ ci: { attempts: 1, closed: "needs_human" } });
  });

  it("closes a finding whose code is no longer at the head", async () => {
    const { result, requests } = await round([finding("old", "return items.at(0);")]);
    expect(result.items).toEqual([{ id: "old", outcome: "gone", reason: "stale" }]);
    expect(requests).toEqual([]);
    expect(result.state.items).toEqual({ old: { attempts: 1, closed: "gone" } });
  });

  it("gives a finding two attempts, then leaves it to a person without a call", async () => {
    const declined = answers("resolves", { loop: null });
    const first = await round([loop], { answer: declined });
    expect(first.result.items).toEqual([{ id: "loop", outcome: "rejected", reason: "declined" }]);
    const second = await round([loop], { answer: declined, state: first.result.state });
    expect(second.result.state.items).toEqual({ loop: { attempts: MEND_LIMITS.attemptsPerItem } });
    const third = await round([loop], { answer: declined, state: second.result.state });
    expect(third.result.outcome).toBe("nothing");
    expect(third.result.items).toEqual([
      { id: "loop", outcome: "needs_human", reason: "attempts" },
    ]);
    expect(third.requests).toEqual([]);
    expect(third.result.state).toEqual(second.result.state);
  });

  it("runs no round past the round cap or the spend limit", async () => {
    const full = { rounds: MEND_LIMITS.rounds, costUsd: 0, items: {} };
    const capped = await round([loop], { state: full });
    expect(capped.result).toMatchObject({ outcome: "stopped", stopped: "rounds", state: full });
    const spent = { rounds: 1, costUsd: 0.5, items: {} };
    const broke = await round([loop], { state: spent, maxCostUsd: 0.5 });
    expect(broke.result).toMatchObject({ outcome: "stopped", stopped: "spend" });
    expect([...capped.requests, ...broke.requests]).toEqual([]);
  });

  it("takes a few findings a round and defers the rest without an attempt", async () => {
    const many = Array.from({ length: MEND_LIMITS.itemsPerRound + 1 }, (_, i) =>
      finding(`f${i}`, LOOP),
    );
    const { result } = await round(many, { answer: answers("unsure") });
    expect(result.items.at(-1)).toEqual({ id: "f5", outcome: "deferred", reason: "no_room" });
    expect(result.state.items.f5).toBeUndefined();
  });

  it("defers a fix on lines another fix of the round changes", async () => {
    const { result, commits } = await round([loop, finding("again", LOOP)]);
    expect(result.items).toEqual([
      { id: "loop", outcome: "fixed", edits: [LOOP_EDIT] },
      { id: "again", outcome: "deferred", reason: "overlap" },
    ]);
    expect(commits).toHaveLength(1);
    expect(result.state.items).toEqual({ loop: { attempts: 1 } });
  });

  it("answers head_moved before any call when the head is not the one named", async () => {
    const { result, requests } = await round([loop], { expectedHead: "d".repeat(40) });
    expect(result).toMatchObject({ outcome: "head_moved", items: [] });
    expect(requests).toEqual([]);
  });

  it("counts no attempt when the branch moved under the commit", async () => {
    const moved = async (): Promise<CommitResult> => ({
      committed: false,
      outcome: "head_moved",
      reason: "the branch has new commits",
    });
    const { result } = await round([loop], { commit: moved });
    expect(result.outcome).toBe("head_moved");
    expect(result.items).toEqual([{ id: "loop", outcome: "deferred", reason: "head_moved" }]);
    expect(result.state.items).toEqual({});
  });

  it("asks no model for a commit the platform cannot take, and still proposes there", async () => {
    const refused = await round([loop], { readOnly: true });
    expect(refused.result.outcome).toBe("not_writable");
    expect(refused.requests).toEqual([]);
    expect(refused.result.state).toEqual({ rounds: 0, costUsd: 0, items: {} });
    const proposed = await round([loop], { readOnly: true, level: "propose" });
    expect(proposed.result.outcome).toBe("proposed");
  });
});
