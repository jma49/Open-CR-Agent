import { describe, expect, it } from "vitest";
import { jiraKeys, tapdKey, tapdKeys } from "./keys.js";

describe("jiraKeys", () => {
  const keys = jiraKeys(["PAY", "AUTH"]);

  it("finds the team's project keys in titles, descriptions and branch names", () => {
    expect(keys("PAY-12: refuse expired cards")).toEqual(["PAY-12"]);
    expect(keys("feature/auth-7-rotate-keys")).toEqual(["AUTH-7"]);
    expect(keys("Fixes PAY-3 and AUTH-40.")).toEqual(["PAY-3", "AUTH-40"]);
  });

  it("ignores other projects and look-alikes", () => {
    expect(keys("UTF-8, OPS-12, PAYMENT-4, auth-2fa, XPAY-3, PAY-0")).toEqual([]);
  });
});

describe("tapdKeys", () => {
  const keys = tapdKeys("20001234");

  it("finds commit keywords and links to the team's workspace", () => {
    expect(keys("--story=1001234 --user=alice")).toEqual(["story-1001234"]);
    expect(
      keys("see https://www.tapd.cn/20001234/prong/stories/view/1120001234001 and --bug=55"),
    ).toEqual(["story-1120001234001", "bug-55"]);
  });

  it("ignores another workspace's links", () => {
    expect(keys("https://www.tapd.cn/99999999/prong/bugs/view/77")).toEqual([]);
  });

  it("parses its own keys back", () => {
    expect(tapdKey("task-9")).toEqual({ kind: "task", id: "9" });
    expect(tapdKey("epic-9")).toBeUndefined();
  });
});
