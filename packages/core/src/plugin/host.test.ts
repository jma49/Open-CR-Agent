import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentRuntime, VcsAdapter } from "../contracts.js";
import type { ReviewEvent } from "../pipeline/report.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import { correctnessReviewerPlugin } from "./builtin.js";
import { startPlugins } from "./host.js";
import { PluginError } from "./registry.js";
import type { OcraPlugin, ToolDefinition } from "./types.js";

const runtime: AgentRuntime = { name: "fake", runTask: async function* () {} };
const vcs = { name: "fake" } as VcsAdapter;
const tool = (name: string): ToolDefinition => ({
  name,
  description: "d",
  inputSchema: z.object({}),
  execute: async () => "ok",
});

describe("startPlugins", () => {
  it("runs bootstrap, configure and postConfigure in lifecycle order", async () => {
    const calls: string[] = [];
    const plugin = (name: string): OcraPlugin => ({
      name,
      bootstrap: async () => {
        calls.push(`${name}:bootstrap`);
      },
      configure: () => {
        calls.push(`${name}:configure`);
      },
      postConfigure: () => {
        calls.push(`${name}:post`);
      },
    });
    await startPlugins([plugin("a"), plugin("b")]);
    expect(calls).toEqual([
      "a:bootstrap",
      "b:bootstrap",
      "a:configure",
      "b:configure",
      "a:post",
      "b:post",
    ]);
  });

  it("collects contributions and creates adapters by name", async () => {
    const listener = vi.fn();
    const registry = await startPlugins([
      correctnessReviewerPlugin,
      {
        name: "infra",
        configure(ctx) {
          ctx.registerVcs("fake-vcs", (options) => ({ ...vcs, options }) as unknown as VcsAdapter);
          ctx.registerRuntime("fake-rt", (options) => ({
            ...runtime,
            name: `models:${options.models.standard}`,
          }));
          ctx.registerRules([{ path: "api/**", rule: "r" }]);
          ctx.registerTool(tool("schema_lookup"));
          ctx.onEvent(listener);
        },
      },
    ]);

    expect(registry.reviewers).toEqual([correctnessReviewer]);
    expect(registry.rules).toEqual([{ path: "api/**", rule: "r" }]);
    expect(registry.tools.map((t) => t.name)).toEqual(["schema_lookup"]);
    expect(
      (registry.createVcs("fake-vcs", { x: 1 }) as unknown as { options: unknown }).options,
    ).toEqual({ x: 1 });
    expect(registry.createRuntime("fake-rt", { models: { standard: ["m"] }, env: {} }).name).toBe(
      "models:m",
    );

    const event: ReviewEvent = { type: "task_progress", taskId: "t", message: "m" };
    registry.emit(event);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it("disables a failing event listener with one warning and keeps the others", async () => {
    const warnings: string[] = [];
    const healthy = vi.fn();
    const registry = await startPlugins(
      [
        {
          name: "flaky-log",
          configure(ctx) {
            ctx.onEvent(() => {
              throw new Error("ENOSPC: no space left on device");
            });
            ctx.onEvent(healthy);
          },
        },
      ],
      { warn: (m) => warnings.push(m) },
    );
    const event: ReviewEvent = { type: "task_progress", taskId: "t", message: "m" };
    expect(() => registry.emit(event)).not.toThrow();
    registry.emit(event);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([
      'Plugin "flaky-log" event listener failed and was disabled: ENOSPC: no space left on device',
    ]);
  });

  it("passes each plugin only its own validated settings", async () => {
    const seen: unknown[] = [];
    const typed: OcraPlugin<{ level: number }> = {
      name: "typed",
      settingsSchema: z.object({ level: z.number().default(1) }),
      configure: (ctx) => {
        seen.push(ctx.settings);
      },
    };
    const untyped: OcraPlugin = {
      name: "untyped",
      configure: (ctx) => void seen.push(ctx.settings),
    };
    await startPlugins([typed as OcraPlugin, untyped], {
      settings: { typed: {}, untyped: { a: 1 }, other: "x" },
    });
    expect(seen).toEqual([{ level: 1 }, { a: 1 }]);

    await expect(
      startPlugins([typed as OcraPlugin], { settings: { typed: { level: "high" } } }),
    ).rejects.toThrow('Invalid settings for plugin "typed"');
  });

  it("warns on bootstrap failures and keeps going", async () => {
    const warn = vi.fn();
    const registry = await startPlugins(
      [
        { name: "flaky", bootstrap: () => Promise.reject(new Error("remote config down")) },
        correctnessReviewerPlugin,
      ],
      { warn },
    );
    expect(warn).toHaveBeenCalledWith('Plugin "flaky" bootstrap failed: remote config down');
    expect(registry.reviewers).toHaveLength(1);
  });

  it("aborts on configure failures with the plugin's name", async () => {
    const broken: OcraPlugin = {
      name: "broken",
      configure: () => {
        throw new Error("missing token");
      },
    };
    await expect(startPlugins([broken])).rejects.toThrow(
      'Plugin "broken" failed to configure: missing token',
    );
  });

  it("rejects duplicate plugins, duplicate registrations and reserved tool names", async () => {
    await expect(
      startPlugins([correctnessReviewerPlugin, correctnessReviewerPlugin]),
    ).rejects.toThrow('Plugin "reviewer-correctness" is loaded twice');

    const second: OcraPlugin = {
      name: "second",
      configure: (ctx) => ctx.registerReviewer(correctnessReviewer),
    };
    await expect(startPlugins([correctnessReviewerPlugin, second])).rejects.toThrow(
      'Plugin "second" cannot register reviewer "correctness": already registered by plugin "reviewer-correctness"',
    );

    const hijack: OcraPlugin = {
      name: "hijack",
      configure: (ctx) => ctx.registerTool(tool("report_finding")),
    };
    await expect(startPlugins([hijack])).rejects.toBeInstanceOf(PluginError);
  });

  it("forbids registration after the configure phase", async () => {
    let late: (() => void) | undefined;
    const sneaky: OcraPlugin = {
      name: "sneaky",
      configure: (ctx) => {
        late = () => ctx.registerReviewer(correctnessReviewer);
      },
    };
    await startPlugins([sneaky]);
    expect(() => late?.()).toThrow('Plugin "sneaky" tried to register after the configure phase');
  });

  it("reports unknown adapters with the available names", async () => {
    const registry = await startPlugins([
      { name: "rt", configure: (ctx) => ctx.registerRuntime("opencode", () => runtime) },
    ]);
    expect(() => registry.createRuntime("pi", { models: {}, env: {} })).toThrow(
      'No runtime named "pi" is registered (available: opencode)',
    );
  });

  it("lets postConfigure inspect what was registered", async () => {
    let summary: unknown;
    await startPlugins([
      correctnessReviewerPlugin,
      {
        name: "audit",
        postConfigure: (ctx) => {
          summary = ctx.registered;
        },
      },
    ]);
    expect(summary).toEqual({
      plugins: ["reviewer-correctness", "audit"],
      vcs: [],
      runtimes: [],
      reviewers: ["correctness"],
      tools: [],
    });
  });
});
