import { lstat, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { configSchema } from "@open-cr-agent/cloud-contract";
import { errorMessage, parseModel } from "@open-cr-agent/core";
import { findRepositoryRoot } from "@open-cr-agent/vcs-local/internal";
import { agentChains } from "../config/cli-config.js";
import { EXIT } from "../io/exit.js";
import type { Output } from "../io/output.js";
import { resolveRepositoryFile, writeRepositoryFile } from "../io/repository-file.js";
import { UsageError } from "../io/usage-error.js";
import { commandsWorkflowFor } from "./init/commands-workflow.js";
import { type Choice, chooseProvider, configFor, PRESETS } from "./init/providers.js";
import { REVIEW_LABEL, type WorkflowKind, workflowFor } from "./init/workflow.js";

const CONFIG_PATH = ".ocra/config.json";
const WORKFLOW_PATH = ".github/workflows/ocra.yml";
const COMMANDS_PATH = ".github/workflows/ocra-commands.yml";

export const INIT_USAGE = `Usage: ocra init [--github [--same-repo-only]] [--provider <name>] [--force]

Set up ocra for this repository: writes ${CONFIG_PATH} with models of the
provider whose key is in the environment. Files that exist are kept.

Options:
  --github           Also write ${WORKFLOW_PATH}: members' pull requests
                     are reviewed on every push, anyone else's when a
                     maintainer adds the ${REVIEW_LABEL} label; and
                     ${COMMANDS_PATH}: "@ocra review" reviews
                     a pull request again, other @ocra mentions are answered
  --same-repo-only   With --github, a pull_request workflow instead: it
                     skips pull requests from forks
  --provider <name>  ${PRESETS.map((p) => p.name).join(", ")}; by default the first key found
                     of ${PRESETS.map((p) => p.keyEnv).join(", ")}. With --github, prefer
                     a single supported key used by the retained configuration's models.
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
  const root = await findRepositoryRoot(cwd);
  const replace = values.force === true;
  const retained =
    values.github && !replace && values.provider === undefined
      ? await existingConfig(root)
      : undefined;
  const preset = PRESETS.find((p) => p.keyEnv === retained?.inferredKey);
  const choice = chooseProvider(values.provider ?? preset?.name, env);

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
      : (retained ?? (await existingConfig(root)));
  const options = { kind, keyEnv, direct: existing.direct };
  const written: string[] = [];
  for (const [path, content, scope] of [
    [WORKFLOW_PATH, workflowFor(options), WORKFLOW_SCOPE[kind]],
    [COMMANDS_PATH, commandsWorkflowFor(options), COMMANDS_SCOPE],
  ] as const) {
    if ((await writeRepositoryFile(root, path, content, { replace })) === "exists") {
      out.write(kept(path));
      continue;
    }
    out.write(`Wrote ${path}: ${scope}\n`);
    written.push(path);
  }
  if (written.length === 0) return EXIT.ok;
  if (!existing.keys.includes(keyEnv)) {
    out.write(`  They pass ${keyEnv} to ocra: check that ${CONFIG_PATH} uses it.\n`);
  }
  out.write(githubNext(kind, keyEnv, written));
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
    lines.push(
      "  The router picks among OpenRouter's free models, so quality varies: good for trying ocra, not for code you must keep private.",
      "  Without credits on the account, OpenRouter allows few free requests a day; a large review may stop part way.",
    );
  }
  return `${lines.join("\n")}\n`;
}

const RUNTIME_NAME = { opencode: "OpenCode runtime", direct: "direct runtime" } as const;

const SWITCH_LATER =
  "OpenCode makes the install about 175 MB; to switch to the 11 MB direct runtime later, see https://github.com/ocrahq/Open-CR-Agent/blob/main/docs/manual/en/providers.mdx#choosing-the-runtime";

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
    "pull requests from this repository's branches are reviewed; those from forks get no secrets and are skipped.",
};

const COMMANDS_SCOPE =
  "a comment @ocra review by someone who can write reviews the pull request again, and ocra answers any other @ocra mention in its thread.";

function githubNext(kind: WorkflowKind, keyEnv: string, written: readonly string[]): string {
  const steps = [
    `Store the key as a repository secret (gh asks for its value):\n       gh secret set ${keyEnv}`,
    ...(kind === "fork-safe"
      ? [
          `Create the label that starts a review of an outside pull request:\n       gh label create ${REVIEW_LABEL} --description "Review this pull request with ocra"`,
        ]
      : []),
    `Commit ${[CONFIG_PATH, ...written].join(", ")}, and merge them into the default branch:\n       ocra reads its configuration from a pull request's base branch,\n       and GitHub runs comment workflows from the default branch.`,
  ];
  return `\nNext:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n`;
}

// What a configuration ocra init did not write says about the workflow: its
// runtime, and the variables its endpoints read their keys from. An
// unreadable one counts as needing OpenCode, the safe side; the review then
// says what is wrong with the file.
async function existingConfig(
  root: string,
): Promise<{ direct: boolean; keys: string[]; inferredKey?: string }> {
  const path = await resolveRepositoryFile(root, CONFIG_PATH);
  try {
    if (!(await lstat(path)).isFile()) return { direct: false, keys: [] };
    const config = configSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const models = [...Object.values(config.models), ...Object.values(agentChains(config))].flatMap(
      (chain) => chain ?? [],
    );
    const usedKeys = new Set<string>();
    let undeclared = false;
    for (const model of models) {
      const { providerID } = parseModel(model);
      if (!Object.hasOwn(config.providers, providerID)) {
        undeclared = true;
        continue;
      }
      const key = config.providers[providerID]?.apiKeyEnv;
      if (key !== undefined) usedKeys.add(key);
    }
    const keys = [...usedKeys];
    // A catalog provider or inherited config can require credentials not declared here.
    const inferredKey =
      config.extends === undefined && !undeclared && keys.length === 1 ? keys[0] : undefined;
    return { direct: config.runtime === "direct", keys, ...(inferredKey && { inferredKey }) };
  } catch {
    return { direct: false, keys: [] };
  }
}
