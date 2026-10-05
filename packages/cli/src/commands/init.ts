import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage } from "@open-cr-agent/core";
import { findRepositoryRoot } from "@open-cr-agent/vcs-local/internal";
import { EXIT } from "../io/exit.js";
import type { Output } from "../io/output.js";
import { writeRepositoryFile } from "../io/repository-file.js";
import { UsageError } from "../io/usage-error.js";
import { type Choice, chooseProvider, configFor, PRESETS } from "./init/providers.js";
import { REVIEW_LABEL, type WorkflowKind, workflowFor } from "./init/workflow.js";

const CONFIG_PATH = ".ocra/config.json";
const WORKFLOW_PATH = ".github/workflows/ocra.yml";

export const INIT_USAGE = `Usage: ocra init [--github [--same-repo-only]] [--provider <name>] [--force]

Set up ocra for this repository: writes ${CONFIG_PATH} with models of the
provider whose key is in the environment. Files that exist are kept.

Options:
  --github           Also write ${WORKFLOW_PATH}: members' pull requests
                     are reviewed on every push, anyone else's when a
                     maintainer adds the ${REVIEW_LABEL} label
  --same-repo-only   With --github, a pull_request workflow instead: it
                     reviews no pull request from a fork
  --provider <name>  ${PRESETS.map((p) => p.name).join(", ")}; by default the first key found
                     of ${PRESETS.map((p) => p.keyEnv).join(", ")}
  --force            Replace the files if they exist
  -h, --help         Show help
`;

type Env = Readonly<Record<string, string | undefined>>;

export async function initCommand(
  argv: string[],
  out: Output,
  { cwd, env }: { cwd: string; env: Env },
): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    out.write(INIT_USAGE);
    return EXIT.ok;
  }
  if (positionals.length > 0) throw new UsageError(`Unexpected argument: ${positionals[0]}`);
  if (values["same-repo-only"] && !values.github) {
    throw new UsageError("--same-repo-only goes with --github");
  }
  const choice = chooseProvider(values.provider, env);
  const root = await findRepositoryRoot(cwd);
  const replace = values.force === true;

  const config = await writeRepositoryFile(root, CONFIG_PATH, configFor(choice.preset), {
    replace,
  });
  out.write(config === "written" ? configWritten(choice) : kept(CONFIG_PATH));
  if (!values.github) {
    if (config === "written") out.write(LOCAL_NEXT);
    return EXIT.ok;
  }

  const kind: WorkflowKind = values["same-repo-only"] ? "same-repo" : "fork-safe";
  const { keyEnv } = choice.preset;
  const existing =
    config === "written"
      ? { direct: choice.preset.runtime === "direct", keys: [keyEnv] }
      : await existingConfig(join(root, CONFIG_PATH));
  const workflow = await writeRepositoryFile(
    root,
    WORKFLOW_PATH,
    workflowFor({ kind, keyEnv, direct: existing.direct }),
    { replace },
  );
  if (workflow === "exists") {
    out.write(kept(WORKFLOW_PATH));
    return EXIT.ok;
  }
  out.write(`Wrote ${WORKFLOW_PATH}: ${WORKFLOW_SCOPE[kind]}\n`);
  if (!existing.keys.includes(keyEnv)) {
    out.write(`  It passes ${keyEnv} to the review: check that ${CONFIG_PATH} uses it.\n`);
  }
  out.write(githubNext(kind, keyEnv));
  return EXIT.ok;
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        github: { type: "boolean" },
        "same-repo-only": { type: "boolean" },
        provider: { type: "string" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
}

function configWritten({ preset, found, others }: Choice): string {
  const lines = [
    `Wrote ${CONFIG_PATH}: ${preset.label} through ${preset.keyEnv}, on the ${RUNTIME_NAME[preset.runtime]}.`,
  ];
  if (found === "environment" && others.length > 0) {
    lines.push(`  Also found ${others.join(", ")}; --provider picks another.`);
  }
  if (preset.runtime === "opencode") lines.push(`  ${SWITCH_LATER}`);
  if (preset.name === "openrouter") {
    lines.push("  A free preview model: good for trying ocra, not for code you must keep private.");
  }
  return `${lines.join("\n")}\n`;
}

const RUNTIME_NAME = { opencode: "OpenCode runtime", direct: "direct runtime" } as const;

const SWITCH_LATER =
  "OpenCode makes the install about 175 MB; to switch to the 11 MB direct runtime later, see https://github.com/jma49/Open-CR-Agent/blob/main/docs/manual/en/providers.mdx#choosing-the-runtime";

function kept(path: string): string {
  return `Kept ${path}: it exists (--force replaces it).\n`;
}

const LOCAL_NEXT = `
Next:
  ocra review --plan    what a review would cover, without a model call
  ocra review           review your uncommitted changes
`;

const WORKFLOW_SCOPE: Record<WorkflowKind, string> = {
  "fork-safe": `pull requests from members are reviewed on every push, anyone else's once each time a maintainer adds the ${REVIEW_LABEL} label.`,
  "same-repo":
    "pull requests from this repository's branches are reviewed; those from forks get no secrets and are not.",
};

function githubNext(kind: WorkflowKind, keyEnv: string): string {
  const steps = [
    `Store the key as a repository secret (gh asks for its value):\n       gh secret set ${keyEnv}`,
    ...(kind === "fork-safe"
      ? [
          `Create the label that starts a review of an outside pull request:\n       gh label create ${REVIEW_LABEL} --description "Review this pull request with ocra"`,
        ]
      : []),
    `Commit ${CONFIG_PATH} and ${WORKFLOW_PATH}, and merge them into the default branch:\n       ocra reads its configuration from a pull request's base branch.`,
  ];
  return `\nNext:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n`;
}

// What a configuration ocra init did not write says about the workflow: its
// runtime, and the variables its endpoints read their keys from. An
// unreadable one counts as needing OpenCode, the safe side; the review then
// says what is wrong with the file.
async function existingConfig(path: string): Promise<{ direct: boolean; keys: string[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { direct: false, keys: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return { direct: false, keys: [] };
  const { runtime, providers } = parsed as { runtime?: unknown; providers?: unknown };
  const keys =
    typeof providers === "object" && providers !== null
      ? Object.values(providers).flatMap((p: { apiKeyEnv?: unknown } | null) =>
          typeof p?.apiKeyEnv === "string" ? [p.apiKeyEnv] : [],
        )
      : [];
  return { direct: runtime === "direct", keys };
}
