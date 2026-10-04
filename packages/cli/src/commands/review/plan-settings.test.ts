import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capture, critical, deps, removeRepos, repoWithChange } from "../../run.fakes.js";
import { run } from "../../run.js";
import { signedIn } from "./cloud.fakes.js";

afterEach(removeRepos);

// Golden output of --plan's settings and their sources, with every layer
// set: ocra's defaults, a shared configuration (extends), the repository's
// file, OCRA_* variables, the ocra Cloud account and the command line. A
// change here is a change users see.

const SHARED_URL = "https://shared.test/ocra.json";
const SHARED = {
  maxCostUsd: 3,
  effort: { light: "low" },
  exclude: ["vendor/**"],
  roles: { judge: { effort: "high" } },
  rules: [{ path: "**", rule: "Shared rule." }],
};
const FILE = {
  extends: SHARED_URL,
  maxTasks: 2,
  include: ["**/*.ts"],
  models: { top: ["google/top"] },
  reviewers: { docs: { enabled: false } },
};
const ENV = { OCRA_MODEL_STANDARD: "google/standard", OCRA_EFFORT_TOP: "high" };
const ACCOUNT = {
  runtime: "direct",
  models: { standard: ["ocra-openrouter/a"], light: ["ocra-openrouter/b"] },
  agents: {
    effort: { standard: "medium", light: "minimal" },
    reviewers: { security: { effort: "high" }, docs: { enabled: true } },
    roles: { verifier: { effort: "low" }, judge: { effort: "minimal" } },
  },
  settings: {
    concurrency: 3,
    maxTasks: 7,
    exclude: ["**/*.md", "vendor/**"],
    rules: [{ path: "**/*.ts", rule: "Account rule." }],
    ultra: true,
  },
  version: "v3",
};

function layered(): { cwd: string; extra: Parameters<typeof deps>[2] } {
  const cwd = repoWithChange();
  mkdirSync(join(cwd, ".ocra"));
  writeFileSync(join(cwd, ".ocra", "config.json"), JSON.stringify(FILE));
  const sharedFetch = (async (input: string | URL | Request) => {
    if (String(input) !== SHARED_URL) return new Response("", { status: 404 });
    return Response.json(SHARED);
  }) as typeof fetch;
  const { cloud } = signedIn({}, ACCOUNT);
  return { cwd, extra: { cloud, env: ENV, fetch: sharedFetch } };
}

async function plan(argv: string[], extra: Parameters<typeof deps>[2], cwd: string) {
  const out = capture();
  const err = capture();
  const code = await run(["review", "--plan", ...argv], out, err, deps(cwd, critical, extra));
  expect(code).toBe(0);
  return { out: out.text(), err: err.text() };
}

const settingsOf = (text: string) => text.slice(text.indexOf("\nSettings"));

// The JSON plan's settings, one line each, and the account's version.
const compact = (plan: { settings: unknown[]; accountSettings?: unknown }) => ({
  accountSettings: plan.accountSettings,
  settings: plan.settings.map((s) => JSON.stringify(s)),
});

describe("--plan's settings and sources (golden)", () => {
  it("prints every layer's settings with their source", async () => {
    const { cwd, extra } = layered();
    const text = await plan([], extra, cwd);
    expect(text.err).toMatchInlineSnapshot(`
      "[ocra] From your ocra Cloud settings: runtime, models.light, effort.standard, reviewers.security, roles.verifier, concurrency, exclude, rules, ultra
      "
    `);
    expect(settingsOf(text.out)).toMatchInlineSnapshot(`
      "
      Settings (under your ocra Cloud settings, version v3):
        runtime             "direct"  (account)
        models.top          ["google/top"]  (file)
        models.standard     ["google/standard"]  (env)
        models.light        ["ocra-openrouter/b"]  (account)
        effort.top          "high"  (env)
        effort.standard     "medium"  (account)
        effort.light        "low"  (shared)
        reviewers.docs      {"enabled":false}  (file)
        reviewers.security  {"effort":"high"}  (account)
        roles.judge         {"effort":"high"}  (shared)
        roles.verifier      {"effort":"low"}  (account)
        concurrency         3  (account)
        maxCostUsd          3  (shared)
        maxTasks            2  (file)
        include             ["**/*.ts"]  (file)
        exclude             ["vendor/**","**/*.md"]  (shared+account)
        rules               [{"path":"**","source":"shared"},{"path":"**/*.ts","source":"account"}]  (shared+account)
        ultra               true  (account)
        default: taskTimeoutMinutes, runTimeoutMinutes, verify, judge, sampling
      "
    `);

    const json = JSON.parse((await plan(["--format", "json"], extra, cwd)).out);
    expect(compact(json)).toMatchInlineSnapshot(`
      {
        "accountSettings": {
          "version": "v3",
        },
        "settings": [
          "{"key":"runtime","value":"direct","source":"account"}",
          "{"key":"models.top","value":["google/top"],"source":"file"}",
          "{"key":"models.standard","value":["google/standard"],"source":"env"}",
          "{"key":"models.light","value":["ocra-openrouter/b"],"source":"account"}",
          "{"key":"effort.top","value":"high","source":"env"}",
          "{"key":"effort.standard","value":"medium","source":"account"}",
          "{"key":"effort.light","value":"low","source":"shared"}",
          "{"key":"reviewers.docs","value":{"enabled":false},"source":"file"}",
          "{"key":"reviewers.security","value":{"effort":"high"},"source":"account"}",
          "{"key":"roles.judge","value":{"effort":"high"},"source":"shared"}",
          "{"key":"roles.verifier","value":{"effort":"low"},"source":"account"}",
          "{"key":"concurrency","value":3,"source":"account"}",
          "{"key":"taskTimeoutMinutes","source":"default"}",
          "{"key":"runTimeoutMinutes","source":"default"}",
          "{"key":"maxCostUsd","value":3,"source":"shared"}",
          "{"key":"maxTasks","value":2,"source":"file"}",
          "{"key":"verify","source":"default"}",
          "{"key":"judge","source":"default"}",
          "{"key":"sampling","source":"default"}",
          "{"key":"include","value":["**/*.ts"],"source":"file"}",
          "{"key":"exclude","value":["vendor/**","**/*.md"],"source":"shared+account"}",
          "{"key":"rules","value":[{"path":"**","source":"shared"},{"path":"**/*.ts","source":"account"}],"source":"shared+account"}",
          "{"key":"ultra","value":true,"source":"account"}",
        ],
      }
    `);
  });

  it("leaves a command-line --ultra out of the account's settings", async () => {
    const { cwd, extra } = layered();
    const json = JSON.parse((await plan(["--ultra", "--format", "json"], extra, cwd)).out);
    expect(json.settings.filter((s: { key: string }) => s.key === "ultra")).toEqual([]);
  });

  it("prints only defaults with no configuration and no account", async () => {
    const cwd = repoWithChange();
    const text = await plan([], {}, cwd);
    expect(settingsOf(text.out)).toMatchInlineSnapshot(`
      "
      Settings:
        default: runtime, models.top, models.standard, models.light, effort.top, effort.standard, effort.light, concurrency, taskTimeoutMinutes, runTimeoutMinutes, maxCostUsd, maxTasks, verify, judge, sampling, include, exclude, rules
      "
    `);
    const json = JSON.parse((await plan(["--format", "json"], {}, cwd)).out);
    expect(compact(json)).toMatchInlineSnapshot(`
      {
        "accountSettings": undefined,
        "settings": [
          "{"key":"runtime","source":"default"}",
          "{"key":"models.top","source":"default"}",
          "{"key":"models.standard","source":"default"}",
          "{"key":"models.light","source":"default"}",
          "{"key":"effort.top","source":"default"}",
          "{"key":"effort.standard","source":"default"}",
          "{"key":"effort.light","source":"default"}",
          "{"key":"concurrency","source":"default"}",
          "{"key":"taskTimeoutMinutes","source":"default"}",
          "{"key":"runTimeoutMinutes","source":"default"}",
          "{"key":"maxCostUsd","source":"default"}",
          "{"key":"maxTasks","source":"default"}",
          "{"key":"verify","source":"default"}",
          "{"key":"judge","source":"default"}",
          "{"key":"sampling","source":"default"}",
          "{"key":"include","source":"default"}",
          "{"key":"exclude","source":"default"}",
          "{"key":"rules","source":"default"}",
        ],
      }
    `);
  });
});
