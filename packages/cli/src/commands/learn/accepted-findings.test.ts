import type { ChangeRequest, FileDiff, VcsAdapter } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import type { TrustedTree } from "../review/target.js";
import { declinedFindingCandidates } from "./accepted-findings.js";

const diffOf = (path: string, patch: string): FileDiff => ({
  oldPath: path,
  newPath: path,
  kind: "modified",
  isBinary: false,
  additions: 1,
  deletions: 0,
  hunks: [],
  patch,
});

function vcs(declined: ChangeRequest["declined"], diff: FileDiff[]): VcsAdapter {
  const change = { id: "o/r#7", title: "t", description: "", baseSha: "b", headSha: "h" };
  return {
    getChangeRequest: async () => ({ ...change, ...(declined ? { declined } : {}) }),
    getDiff: async () => diff,
  } as unknown as VcsAdapter;
}

const tree = (files: Record<string, string>): TrustedTree => ({
  readFile: async (path) => files[path],
  listFiles: async () => [],
});

const declinedOn = (file: string, fingerprint: string) => ({
  by: "maintainer",
  fingerprint,
  title: "Token is not validated",
  file,
  reason: "Won't fix: the gateway validates it.",
});

describe("declinedFindingCandidates", () => {
  it("gives each declined finding its reason and its file as the change has it", async () => {
    const candidates = await declinedFindingCandidates(
      vcs(
        [declinedOn("src/auth.ts", "a".repeat(16)), declinedOn("src/old.ts", "b".repeat(16))],
        [diffOf("src/auth.ts", "+const token = read();")],
      ),
      tree({ "src/old.ts": "export const old = 1;\n" }),
    );
    expect(candidates.map((c) => c.ref)).toEqual(["a".repeat(16), "b".repeat(16)]);
    const [changed, unchanged] = await Promise.all(candidates.map((c) => c.evidence()));
    expect(changed).toMatchObject({
      kind: "accepted-finding",
      source: { kind: "review-feedback", ref: "a".repeat(16) },
      subject: "Token is not validated",
      message: "Won't fix: the gateway validates it.",
    });
    expect(changed?.files.map((f) => f.patch)).toEqual(["+const token = read();"]);
    expect(unchanged?.files.map((f) => f.patch)).toEqual([" export const old = 1;\n "]);
  });

  it("has nothing for a change request nobody declined a finding on, or a file that is gone", async () => {
    expect(await declinedFindingCandidates(vcs(undefined, []), tree({}))).toEqual([]);
    const [gone] = await declinedFindingCandidates(
      vcs([declinedOn("src/gone.ts", "c".repeat(16))], []),
      tree({}),
    );
    expect((await gone?.evidence())?.files).toEqual([]);
  });
});
