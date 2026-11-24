import { describe, expect, it } from "vitest";
import upload from "../fixtures/upload.json" with { type: "json" };
import { MAX_TRACE_TASKS, sharedTraceSchema } from "./trace.js";
import { reviewUploadSchema } from "./upload.js";

const { about: _, ...body } = upload;

describe("the shared trace", () => {
  it("is in the upload fixture, whole", () => {
    expect(sharedTraceSchema.parse(body.trace)).toEqual(body.trace);
    expect(reviewUploadSchema.parse(body).trace).toEqual(body.trace);
  });

  it("reads a trace that does not fit as absent, and keeps the rest", () => {
    const tasks = Array.from({ length: MAX_TRACE_TASKS + 1 }, () => body.trace.tasks[0]);
    const parsed = reviewUploadSchema.parse({ ...body, trace: { ...body.trace, tasks } });
    expect(parsed.trace).toBeUndefined();
    expect(parsed.runId).toBe(body.runId);
  });

  it("takes no searched literal or answer text", () => {
    const attempt = { ...body.trace.tasks[0]?.attempts[0], searched: ["secret("], text: "answer" };
    const task = { ...body.trace.tasks[0], attempts: [attempt] };
    const parsed = sharedTraceSchema.parse({ ...body.trace, tasks: [task] });
    expect(JSON.stringify(parsed)).not.toContain("secret(");
    expect(JSON.stringify(parsed)).not.toContain("answer");
  });
});
