import type { LinkedTaskUse } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { sharedLinkedTasks } from "./linked-tasks.js";

const task: LinkedTaskUse = {
  tracker: "gitlab",
  key: "#7",
  url: "https://gitlab.example.com/g/p/-/issues/7",
  title: "Rotate the key sk-live-0123456789abcdef",
  state: "closed",
  labels: ["security"],
  cut: false,
};

describe("sharedLinkedTasks", () => {
  it("sends which task and its state, and what it says only with the findings", () => {
    expect(sharedLinkedTasks([task], false)).toEqual([
      { tracker: "gitlab", key: "#7", url: task.url, state: "closed" },
    ]);
    const [shared] = sharedLinkedTasks([task], true);
    expect(shared?.labels).toEqual(["security"]);
    expect(shared?.title).not.toContain("sk-live-0123456789abcdef");
  });
});
