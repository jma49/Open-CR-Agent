import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTaskSpec } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseAccountPlugins } from "../../plugins/account.js";
import { allowInstalled, install, signedInCloud } from "../../plugins/plugins.fakes.js";
import { pluginsDir } from "../../plugins/store.js";
import { capture, critical, deps, removeRepos, repoWithChange } from "../../run.fakes.js";
import { run } from "../../run.js";

const homes: string[] = [];
afterEach(() => {
  removeRepos();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REPO_PLUGIN = `export default {
  name: "repo-plugin",
  configure(ctx) {
    ctx.registerRules([{ path: "**", rule: "REPO PLUGIN RULE " + JSON.stringify(ctx.settings ?? null) }]);
  },
};
`;

function preferences(plugins: unknown, pluginSettings: unknown = {}) {
  return { settings: { plugins, pluginSettings }, version: "v1" };
}

async function review(
  prefs: unknown,
  options: { args?: string[]; setup?: (cwd: string, dir: string) => Promise<void> } = {},
) {
  const cwd = repoWithChange();
  const home = mkdtempSync(join(tmpdir(), "ocra-acctplug-"));
  homes.push(home);
  const env = { XDG_CONFIG_HOME: home };
  await options.setup?.(cwd, pluginsDir(env));
  const prompts: string[] = [];
  const script = async function* (spec: AgentTaskSpec): AsyncIterable<AgentEvent> {
    prompts.push(spec.userPrompt);
    yield* critical(spec);
  };
  const err = capture();
  const code = await run(
    ["review", "--no-upload", ...(options.args ?? [])],
    capture(),
    err,
    deps(cwd, script, { env, cloud: signedInCloud(home, prefs) }, true),
  );
  return { code, err: err.text(), prompt: prompts.join("\n") };
}

describe("plugins named by the ocra Cloud account (ADR-0027)", () => {
  it("load only from the machine's allowed directory, with the account's settings for them by package name", async () => {
    const { prompt, err } = await review(
      preferences(["ocra-plugin-x"], {
        "ocra-plugin-x": { level: 2 },
        // The plugin's own name ("acct-plugin") is not how ocra Cloud keys them.
        "acct-plugin": { level: 9 },
        "repo-plugin": { fromAccount: true },
      }),
      {
        setup: async (cwd, dir) => {
          await allowInstalled(dir, "ocra-plugin-x");
          mkdirSync(join(cwd, ".ocra"));
          writeFileSync(join(cwd, "repo-plugin.mjs"), REPO_PLUGIN);
          writeFileSync(
            join(cwd, ".ocra", "config.json"),
            JSON.stringify({ plugins: ["./repo-plugin.mjs"] }),
          );
        },
      },
    );
    expect(err).not.toContain("Warning");
    expect(prompt).toContain('ACCOUNT PLUGIN RULE {"level":2}');
    // A repository plugin's settings come from the repository alone.
    expect(prompt).toContain("REPO PLUGIN RULE null");
    expect(prompt).not.toContain("fromAccount");
  });

  it("skip a plugin this machine has not allowed with one warning, never loading the checkout's copy", async () => {
    const { prompt, err, code } = await review(preferences(["ocra-plugin-x", "@acme/other"]), {
      setup: async (cwd) => {
        install(
          cwd,
          "ocra-plugin-x",
          "1.0.0",
          "sha512-ok",
          'export default { name: "acct-plugin", configure(ctx) { ctx.registerRules([{ path: "**", rule: "CHECKOUT COPY" }]); } };',
        );
      },
    });
    expect(code).toBe(1);
    expect(prompt).not.toContain("CHECKOUT COPY");
    const warnings = err.split("\n").filter((line) => line.includes("not allowed"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ocra-plugin-x, @acme/other");
    expect(warnings[0]).toContain("ocra plugins allow <name>@<version>");
  });

  it("do not load with --no-repo-config", async () => {
    const { prompt, err } = await review(preferences(["ocra-plugin-x"]), {
      args: ["--no-repo-config"],
      setup: (_cwd, dir) => allowInstalled(dir, "ocra-plugin-x"),
    });
    expect(prompt).not.toContain("ACCOUNT PLUGIN RULE");
    expect(err).toContain("do not load for pull or merge requests or with --no-repo-config");
  });

  it("skip a plugin changed since it was allowed", async () => {
    const { prompt, err } = await review(preferences(["ocra-plugin-x"]), {
      setup: async (_cwd, dir) => {
        await allowInstalled(dir, "ocra-plugin-x");
        const lockPath = join(dir, "package-lock.json");
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        lock.packages["node_modules/ocra-plugin-x"].integrity = "sha512-swapped";
        writeFileSync(lockPath, JSON.stringify(lock));
      },
    });
    expect(prompt).not.toContain("ACCOUNT PLUGIN RULE");
    expect(err).toContain("skipping plugin ocra-plugin-x from your ocra Cloud settings");
  });

  it("skip a plugin whose name a loaded plugin already has", async () => {
    const { err, code } = await review(preferences(["ocra-plugin-x"]), {
      setup: (_cwd, dir) =>
        allowInstalled(dir, "ocra-plugin-x", 'export default { name: "vcs-local" };'),
    });
    expect(code).toBe(1);
    expect(err).toContain('a plugin named "vcs-local" is already loaded');
  });
});

describe("parseAccountPlugins", () => {
  it("takes package names only, never a path, a URL or a version", () => {
    const warnings: string[] = [];
    const parsed = parseAccountPlugins(
      {
        settings: {
          plugins: ["ok-plugin", "@scope/ok", "./local.js", "/abs.js", "x@1.0.0", "https://e/x", 3],
          pluginSettings: { "ok-plugin": { a: 1 } },
        },
      },
      (m) => warnings.push(m),
    );
    expect(parsed).toEqual({
      plugins: ["ok-plugin", "@scope/ok"],
      pluginSettings: { "ok-plugin": { a: 1 } },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"./local.js"');
  });
});
