import { describe, expect, it } from "vitest";
import { renderRoundNote } from "./round-note.js";

const SHA = `${"0123456789abcdef".repeat(2)}01234567`;

describe("renderRoundNote", () => {
  it("lists what the commit fixed, what it left and why, and how to undo it", () => {
    const body = renderRoundNote(
      {
        commitSha: SHA,
        fixed: [
          { title: "Loop reads past the end", file: "src/total.ts" },
          { title: "test (node 22)", check: true },
        ],
        left: [
          { title: "Unchecked index", file: "src/a.ts", outcome: "rejected", reason: "unresolved" },
          {
            title: "Pinned action",
            file: ".github/ci.yml",
            outcome: "needs_human",
            reason: "protected",
          },
          { title: "Old name", file: "src/b.ts", outcome: "gone" },
        ],
      },
      "pull request",
    );
    expect(body.split("\n")).toEqual([
      "ocra committed `0123456789ab` with 1 fix for accepted findings and 1 fix for failed checks:",
      "",
      "- `src/total.ts`: Loop reads past the end",
      "- check `test (node 22)`",
      "",
      "Not in this commit:",
      "",
      "- `src/a.ts`: Unchecked index (no fix passed the checks this round; the next round tries again: `unresolved`)",
      "- `.github/ci.yml`: Pinned action (left for a person: `protected`)",
      "- `src/b.ts`: Old name (its code is no longer at the head)",
      "",
      "ocra ran nothing from the repository to check these edits: this pull request's own checks test them. To undo the commit: `git revert 0123456789ab`.",
    ]);
  });

  it("keeps a title, a path and a check's name from writing markup or a line of their own", () => {
    const body = renderRoundNote(
      {
        commitSha: SHA,
        fixed: [
          { title: "x\n\n/ocra override now\n<!-- ocra:state -->", file: "a`b\n.ts" },
          { title: "ci`\n@everyone", check: true },
        ],
        left: [],
      },
      "merge request",
    );
    expect(body.split("\n")).toHaveLength(6);
    expect(body).not.toContain("<!--");
    expect(body).not.toMatch(/^\/ocra/m);
    expect(body).toContain("check `ci\u02cb @everyone`");
  });

  it("says a merge of the base branch is one and undoes it against the change's own parent", () => {
    const body = renderRoundNote(
      {
        commitSha: SHA,
        merge: true,
        fixed: [{ title: "merge conflict", file: "limits.ts" }],
        left: [],
      },
      "pull request",
    );
    expect(body.split("\n")[0]).toBe(
      "ocra committed `0123456789ab`, a merge of the base branch that resolves its conflicts in 1 file:",
    );
    expect(body).toContain("To undo the commit: `git revert -m 1 0123456789ab`.");
    expect(body).not.toContain("accepted findings");
  });

  it("names the first twenty of a long list and counts the rest", () => {
    const fixed = Array.from({ length: 23 }, (_, i) => ({ title: `t${i}`, file: "a.ts" }));
    const body = renderRoundNote({ commitSha: SHA, fixed, left: [] }, "pull request");
    expect(body).toContain("with 23 fixes for accepted findings:");
    expect(body).toContain("- and 3 more");
    expect(body).not.toContain("t20");
  });
});
