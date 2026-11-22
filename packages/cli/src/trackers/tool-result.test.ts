import { describe, expect, it } from "vitest";
import { MAX_RESULT_CHARS, taskFromResult } from "./tool-result.js";

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

describe("taskFromResult", () => {
  it("reads a Jira issue's fields", () => {
    const issue = {
      key: "PAY-12",
      fields: {
        summary: "Refuse expired cards",
        description: "Cards past expiry get a 402.",
        status: { name: "Done" },
        labels: ["payments"],
      },
    };
    expect(taskFromResult("jira", "PAY-12", text(JSON.stringify(issue)))).toEqual({
      tracker: "jira",
      key: "PAY-12",
      title: "Refuse expired cards",
      state: "closed",
      labels: ["payments"],
      body: "Cards past expiry get a 402.",
      subtasks: [],
    });
  });

  it("reads a TAPD story under its wrapper", () => {
    const answer = {
      data: { Story: { name: "登录限流", description: "每分钟 5 次", status: "developing" } },
    };
    const task = taskFromResult("tapd", "story-1", { structuredContent: answer });
    expect(task).toMatchObject({ title: "登录限流", body: "每分钟 5 次", state: "open" });
  });

  it("keeps plain text as the body, cut to the limit", () => {
    const long = "x".repeat(MAX_RESULT_CHARS + 10);
    const task = taskFromResult("jira", "PAY-1", text(long));
    expect(task.title).toBe("PAY-1");
    expect(task.body).toHaveLength(MAX_RESULT_CHARS);
  });

  it("throws the tool's error", () => {
    expect(() =>
      taskFromResult("jira", "PAY-1", { ...text("Issue does not exist"), isError: true }),
    ).toThrow("Issue does not exist");
  });
});
