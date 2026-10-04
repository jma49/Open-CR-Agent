import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OcraPlugin, RuntimeOptions } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseReviewArgs, type ReviewArgs } from "./review/args.js";
import { BUILTIN_PLUGINS } from "./review/command.js";
import { type CliConfig, loadConfig } from "./review/config.js";
import { configHash, requestedSampling } from "./review/provenance.js";
import { capture, deps, removeRepos, repoWithChange } from "./run.fakes.js";
import { run } from "./run.js";
import { VERSION } from "./version.js";

afterEach(removeRepos);

const args = (argv: string[] = []) => parseReviewArgs(argv) as ReviewArgs;

describe("requestedSampling", () => {
  it("takes the configuration's sampling, with the flags on top", async () => {
    const config = await loadConfig("/nowhere", {}, { repository: false });
    expect(requestedSampling(config, args())).toEqual({});
    const configured: CliConfig = { ...config, sampling: { temperature: 0.7, seed: 1 } };
    expect(requestedSampling(configured, args())).toEqual({ temperature: 0.7, seed: 1 });
    expect(requestedSampling(configured, args(["--temperature", "0", "--seed", "9"]))).toEqual({
      temperature: 0,
      seed: 9,
    });
  });

  it("refuses a temperature or seed out of range", () => {
    expect(() => args(["--temperature", "3"])).toThrow(/--temperature must be/);
    expect(() => args(["--temperature", ""])).toThrow(/--temperature must be/);
    expect(() => args(["--seed=-1"])).toThrow(/--seed must be/);
    expect(() => args(["--seed", "1.5"])).toThrow(/--seed must be/);
  });
});

describe("configHash", () => {
  const base = async () => ({
    ...(await loadConfig("/nowhere", {}, { repository: false })),
    providers: {
      local: { baseUrl: "https://llm.example.com/v1", apiKeyEnv: "K", models: {} },
    },
  });

  it("changes with the configuration and the review flags, not with sampling", async () => {
    const config = await base();
    const hash = configHash(config, args());
    expect(configHash({ ...config, models: { top: ["a/b"] } }, args())).not.toBe(hash);
    expect(configHash(config, args(["--ultra"]))).not.toBe(hash);
    expect(configHash({ ...config, sampling: { temperature: 0 } }, args())).toBe(hash);
  });

  it("leaves out a password written into a provider's address", async () => {
    const config = await base();
    const withPassword = {
      ...config,
      providers: {
        local: { ...config.providers.local, baseUrl: "https://u:sk-secret@llm.example.com/v1" },
      },
    } as CliConfig;
    expect(configHash(withPassword, args())).toBe(configHash(config, args()));
  });
});

describe("ocra review provenance", () => {
  // A runtime that applies the temperature and not the seed, like OpenCode.
  function recording(seen: Omit<RuntimeOptions, "tools">[]): OcraPlugin {
    return {
      name: "runtime-opencode",
      configure(ctx) {
        ctx.registerRuntime("opencode", (options) => {
          seen.push(options);
          const t = options.sampling?.temperature;
          return {
            name: "fake",
            sampling: {
              ...(t === undefined ? {} : { temperature: t }),
              ...(options.sampling?.seed === undefined ? {} : { notApplied: ["seed" as const] }),
            },
            async *runTask(spec) {
              yield { type: "done", taskId: spec.taskId };
            },
          };
        });
      },
    };
  }

  async function review(cwd: string, flags: string[]) {
    const seen: Omit<RuntimeOptions, "tools">[] = [];
    const plugins = BUILTIN_PLUGINS.map((p) =>
      p.name === "runtime-opencode" ? recording(seen) : p,
    );
    const code = await run(
      ["review", "--format", "json", "--output", "r.json", ...flags],
      capture(),
      capture(),
      deps(cwd, async function* () {}, { builtinPlugins: plugins }),
    );
    expect(code).toBe(0);
    return { seen, report: JSON.parse(readFileSync(join(cwd, "r.json"), "utf8")) };
  }

  it("records the version, the hashes and the sampling the runtime applied", async () => {
    const cwd = repoWithChange();
    const { seen, report } = await review(cwd, ["--temperature", "0", "--seed", "5"]);
    expect(seen[0]?.sampling).toEqual({ temperature: 0, seed: 5 });
    expect(report.provenance).toEqual({
      ocraVersion: VERSION,
      promptHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      configHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      sampling: { temperature: 0, notApplied: ["seed"] },
    });
    // The session's report.json carries it too.
    const sessions = join(cwd, ".ocra", "sessions");
    const session = readFileSync(join(sessions, report.runId, "report.json"), "utf8");
    expect(JSON.parse(session).provenance).toEqual(report.provenance);
  });

  it("asks for no sampling unless configured, and reads it from the configuration", async () => {
    const cwd = repoWithChange();
    const plain = await review(cwd, []);
    expect(plain.seen[0]).not.toHaveProperty("sampling");
    expect(plain.report.provenance.sampling).toEqual({});

    mkdirSync(join(cwd, ".ocra"), { recursive: true });
    writeFileSync(join(cwd, ".ocra", "config.json"), '{"sampling":{"temperature":0.3}}');
    const configured = await review(cwd, []);
    expect(configured.seen[0]?.sampling).toEqual({ temperature: 0.3 });
    expect(configured.report.provenance.sampling).toEqual({ temperature: 0.3 });
    expect(configured.report.provenance.configHash).toBe(plain.report.provenance.configHash);
    expect(configured.report.provenance.promptHash).toBe(plain.report.provenance.promptHash);
  });
});
