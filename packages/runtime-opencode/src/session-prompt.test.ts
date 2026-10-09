import { describe, expect, it } from "vitest";
import type { SessionMessage } from "./session-outcome.js";
import { promptSession } from "./session-prompt.js";

const REPORT_TOOL = "ocra_report_finding";
const input = { title: "t", agent: "a", model: "google/m", system: "s", user: "u", tools: {} };

// What OpenCode holds for a session that reported one finding before it was
// cut off.
const spent: SessionMessage[] = [
  {
    info: { role: "assistant", cost: 0.25, tokens: { input: 1000, output: 50 } },
    parts: [
      {
        type: "tool",
        tool: REPORT_TOOL,
        state: { status: "completed", input: { title: "x" } },
      },
    ],
  },
];

function session(prompt: (signal: AbortSignal) => Promise<never>) {
  const aborted: string[] = [];
  return {
    aborted,
    api: {
      create: async () => ({ data: { id: "s1" } }),
      prompt: async (_: unknown, options: { signal: AbortSignal }) => prompt(options.signal),
      messages: async () => ({ data: spent }),
      abort: async ({ sessionID }: { sessionID: string }) => {
        aborted.push(sessionID);
        return { data: true };
      },
    } as never,
  };
}

describe("promptSession", () => {
  it("stops the session and keeps its spend and findings when the transport fails", async () => {
    const fake = session(async () => {
      throw new TypeError("terminated");
    });
    const outcome = await promptSession(fake.api, input, REPORT_TOOL, new AbortController().signal);
    expect(fake.aborted).toEqual(["s1"]);
    expect(outcome.usage.costUsd).toBe(0.25);
    expect(outcome.findings).toHaveLength(1);
    // Retryable: the next model in the chain gets its turn.
    expect(outcome.error).toEqual({ message: "terminated", retryable: true });
  });

  it("does the same when the task is cancelled, without retrying", async () => {
    const controller = new AbortController();
    const fake = session(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    setTimeout(() => controller.abort(), 10);
    const outcome = await promptSession(fake.api, input, REPORT_TOOL, controller.signal);
    expect(fake.aborted).toContain("s1");
    expect(outcome.usage.inputTokens).toBe(1000);
    expect(outcome.error).toEqual({ message: "cancelled", retryable: false });
  });

  it("stops a silent session and lets the next model try", async () => {
    const aborted: string[] = [];
    const api = {
      create: async () => ({ data: { id: "s1" } }),
      // Busy until something aborts the request.
      prompt: (_: unknown, options: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
      messages: async () => ({ data: spent }),
      abort: async ({ sessionID }: { sessionID: string }) => {
        aborted.push(sessionID);
        return { data: true };
      },
    } as never;
    const outcome = await promptSession(api, input, REPORT_TOOL, new AbortController().signal, {
      inactivityMs: 60,
      pollMs: 20,
    });
    expect(outcome.error).toEqual({ message: "no activity for 0s", retryable: true });
    expect(aborted).toContain("s1");
    // What the session did before it went silent is kept.
    expect(outcome.usage.costUsd).toBe(0.25);
  });

  it("lets a session that keeps writing run past the inactivity window", async () => {
    let text = "";
    const aborted: string[] = [];
    const api = {
      create: async () => ({ data: { id: "s1" } }),
      // Resolves after the window, unless something aborts it first.
      prompt: (_: unknown, options: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          setTimeout(() => resolve({ data: {} }), 200);
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      messages: async () => {
        text += "more ";
        return {
          data: [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }],
        };
      },
      abort: async ({ sessionID }: { sessionID: string }) => {
        aborted.push(sessionID);
        return { data: true };
      },
    } as never;
    const outcome = await promptSession(api, input, REPORT_TOOL, new AbortController().signal, {
      inactivityMs: 60,
      pollMs: 20,
    });
    expect(outcome.error).toBeUndefined();
    expect(aborted).toEqual([]);
  });

  it("reports what a running session has spent as it grows", async () => {
    let step = 0;
    const api = {
      create: async () => ({ data: { id: "s1" } }),
      prompt: () => new Promise((resolve) => setTimeout(() => resolve({ data: {} }), 150)),
      // One more finished step, costing $0.10, every time the session is read.
      messages: async () => {
        step += 1;
        return {
          data: Array.from({ length: step }, () => ({
            info: { role: "assistant", cost: 0.1, tokens: { input: 100 } },
            parts: [{ type: "step-start" }],
          })),
        };
      },
      abort: async () => ({ data: true }),
    } as never;
    const reports: number[] = [];
    await promptSession(api, input, REPORT_TOOL, new AbortController().signal, {
      pollMs: 20,
      onUsage: (spent) => reports.push(spent.costUsd),
    });
    expect(reports.length).toBeGreaterThanOrEqual(3);
    expect(reports.every((cost, i) => i === 0 || cost > (reports[i - 1] ?? 0))).toBe(true);
  });

  it("keeps what a session spent when OpenCode answers with an error", async () => {
    const api = {
      create: async () => ({ data: { id: "s1" } }),
      prompt: async () => ({ error: { name: "ProviderError" } }),
      messages: async () => ({ data: spent }),
      abort: async () => ({ data: true }),
    } as never;
    const outcome = await promptSession(api, input, REPORT_TOOL, new AbortController().signal);
    expect(outcome.usage.costUsd).toBe(0.25);
    expect(outcome.error?.retryable).toBe(false);
  });

  it("does not rerun a finished session whose messages could not be read", async () => {
    let reads = 0;
    const api = {
      create: async () => ({ data: { id: "s1" } }),
      prompt: async () => ({ data: {} }),
      messages: async () => {
        reads += 1;
        if (reads === 1) throw new TypeError("socket hang up");
        return { data: spent };
      },
      abort: async () => ({ data: true }),
    } as never;
    const outcome = await promptSession(api, input, REPORT_TOOL, new AbortController().signal);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.error).toEqual({
      message: "could not read the finished session: socket hang up",
      retryable: false,
    });
  });

  it("keeps the findings and spend of a session when one of its messages is not understood", async () => {
    const api = {
      create: async () => ({ data: { id: "s1" } }),
      prompt: async () => ({ data: {} }),
      // A message in a shape this version of ocra does not know.
      messages: async () => ({ data: [...spent, { info: { role: 7 }, parts: "?" }] }),
      abort: async () => ({ data: true }),
    } as never;
    const outcome = await promptSession(api, input, REPORT_TOOL, new AbortController().signal);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.usage.costUsd).toBe(0.25);
    expect(outcome.error).toBeUndefined();
    expect(outcome.unreadMessages).toBe(1);
  });

  describe("an agent that stops before finishing", () => {
    const DONE = "ocra_task_done";
    const resume = { doneTool: DONE, maxSteps: 30, message: "Finish the review." };
    const step = (parts: SessionMessage["parts"], cost = 0.1): SessionMessage => ({
      info: { role: "assistant", cost, tokens: { input: 100, output: 10 } },
      parts: [{ type: "step-start" }, ...parts],
    });
    const read = step([{ type: "tool", tool: "ocra_read_file", state: { status: "completed" } }]);
    const report = (title: string) =>
      step([{ type: "tool", tool: REPORT_TOOL, state: { status: "completed", input: { title } } }]);
    const done = step([{ type: "tool", tool: DONE, state: { status: "completed" } }]);

    // Each prompt appends the turns it produced to the session.
    function scripted(turns: SessionMessage[][]) {
      const sent: string[] = [];
      const messages: SessionMessage[] = [];
      const api = {
        create: async () => ({ data: { id: "s1" } }),
        prompt: async (body: { parts: { text: string }[] }) => {
          sent.push(body.parts[0]?.text ?? "");
          messages.push(...(turns.shift() ?? []));
          return { data: {} };
        },
        messages: async () => ({ data: messages }),
        abort: async () => ({ data: true }),
      } as never;
      return { api, sent };
    }

    it("is told once to finish, and both turns count", async () => {
      const { api, sent } = scripted([
        [read, report("first")],
        [report("second"), done],
      ]);
      const outcome = await promptSession(
        api,
        { ...input, resume },
        REPORT_TOOL,
        new AbortController().signal,
      );
      expect(sent).toEqual(["u", "Finish the review."]);
      expect(outcome.resumed).toBe(true);
      expect(outcome.findings).toEqual([{ title: "first" }, { title: "second" }]);
      expect(outcome.usage.costUsd).toBeCloseTo(0.4);
    });

    it("is told only once even when it stops again", async () => {
      const { api, sent } = scripted([[read], [read], [done]]);
      await promptSession(api, { ...input, resume }, REPORT_TOOL, new AbortController().signal);
      expect(sent).toHaveLength(2);
    });

    it.each([
      ["it called the done tool", [read, done]],
      [
        "it answered in text",
        [read, { ...step([]), parts: [{ type: "text", text: "No issues." }] }],
      ],
      ["it used every step", Array.from({ length: 30 }, () => read)],
    ])("is left alone when %s", async (_why, turn) => {
      const { api, sent } = scripted([turn as SessionMessage[]]);
      const outcome = await promptSession(
        api,
        { ...input, resume },
        REPORT_TOOL,
        new AbortController().signal,
      );
      expect(sent).toHaveLength(1);
      expect(outcome.resumed).toBeUndefined();
    });

    it.each([
      ["its only turn used every step", [Array.from({ length: 30 }, () => read)], true],
      ["its resumed turn used every step", [[read], Array.from({ length: 30 }, () => read)], true],
      // Each prompt has its own cap: 8 and 22 steps reach 30 between them.
      [
        "only its two turns together reach the cap",
        [Array.from({ length: 8 }, () => read), Array.from({ length: 22 }, () => read)],
        false,
      ],
    ])("says whether it stopped at the step cap when %s (#477)", async (_why, turns, capped) => {
      const { api } = scripted(turns as SessionMessage[][]);
      const outcome = await promptSession(
        api,
        { ...input, resume },
        REPORT_TOOL,
        new AbortController().signal,
      );
      expect(outcome.atStepCap === true).toBe(capped);
    });

    it("is not resumed for helper calls, which have no resume options", async () => {
      const { api, sent } = scripted([[read]]);
      await promptSession(api, input, REPORT_TOOL, new AbortController().signal);
      expect(sent).toHaveLength(1);
    });
  });
});
