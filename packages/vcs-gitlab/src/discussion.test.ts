import { describe, expect, it } from "vitest";
import { AUTHOR, MAINTAINER } from "../../vcs-platform/src/conformance.fakes.js";
import { adapter, bodies, fakeGitLab } from "./adapter.fakes.js";

describe("a mention on GitLab", () => {
  it("reads a note on a line with its discussion and replies in it", async () => {
    const { calls, fetchImpl } = fakeGitLab({
      threads: [
        {
          comments: [
            { author: AUTHOR, body: "Adds b." },
            { author: MAINTAINER, body: "@ocra why b?" },
          ],
        },
      ],
    });
    const mention = await adapter(fetchImpl).mention({ id: "101" });
    if (!mention.asked) throw new Error(mention.reason);
    expect(mention).toMatchObject({
      question: "why b?",
      thread: [{ author: AUTHOR, body: "Adds b." }],
      on: { path: "src/login.ts", line: 2 },
    });
    await mention.answer("Because.");
    expect(bodies(calls, "POST", "/discussions/d0/notes")).toEqual([
      "<!-- ocra:reply 101 -->\nBecause.",
    ]);
  });

  it("refuses a note whose editor GitLab does not say", async () => {
    const { fetchImpl } = fakeGitLab(
      { comments: [{ author: MAINTAINER, body: "@ocra why?" }] },
      { unknownEditors: [1] },
    );
    const mention = await adapter(fetchImpl).mention({ id: "1" });
    expect(mention.asked).toBe(false);
  });
});
