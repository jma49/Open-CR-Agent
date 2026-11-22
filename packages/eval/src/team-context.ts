import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { LEARNINGS_DIR } from "@open-cr-agent/cloud-contract";
import { EVAL_IDENTITY } from "./attack.js";
import { exec } from "./exec.js";
import type { CaseLearning, Instance } from "./instance.js";
import { GIT_ENV } from "./repos.js";

export interface ContextualReview {
  target: Instance;
  args: string[];
}

// Learnings reach a review only from its trusted base (ADR-0060), so they
// are committed onto the case's base and every commit of the range is
// replayed on top: the diff and the commit subjects stay the same. Project
// documents are named in a copy of the --config file. Nothing touches a ref, the working tree or the
// index, and the same case gives the same commits on every run.
export async function withTeamContext(
  dir: string,
  instance: Instance,
  args: readonly string[],
): Promise<ContextualReview> {
  const team = instance.golden?.team;
  if (!team) return { target: instance, args: [...args] };
  const target = team.learnings
    ? { ...instance, ...(await overlayLearnings(dir, instance, team.learnings)) }
    : instance;
  return {
    target,
    args: team.projectDocs
      ? await withProjectDocs(dir, instance.id, args, team.projectDocs)
      : [...args],
  };
}

export function learningFile({ name: _name, body, ...frontmatter }: CaseLearning): string {
  // JSON is YAML: the frontmatter needs no serializer of its own.
  return `---\n${JSON.stringify(frontmatter)}\n---\n${body}\n`;
}

async function overlayLearnings(
  dir: string,
  instance: Instance,
  learnings: readonly CaseLearning[],
): Promise<{ baseCommit: string; headCommit: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "ocra-team-"));
  const git = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = await exec("git", args, {
      cwd: dir,
      env: { ...GIT_ENV, ...EVAL_IDENTITY, ...env },
    });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  try {
    const entries: string[] = [];
    for (const learning of learnings) {
      const path = join(scratch, `${learning.name}.md`);
      await writeFile(path, learningFile(learning));
      const blob = await git(["hash-object", "-w", "--no-filters", "--", path]);
      entries.push(`100644,${blob},${LEARNINGS_DIR}/${learning.name}.md`);
    }
    const index = { GIT_INDEX_FILE: join(scratch, "index") };
    const withLearnings = async (commit: string) => {
      const present = await git([
        "ls-tree",
        "--name-only",
        "--end-of-options",
        commit,
        "--",
        LEARNINGS_DIR,
      ]);
      if (present !== "") throw new Error(`${commit} already holds ${LEARNINGS_DIR}`);
      await git(["read-tree", "--end-of-options", commit], index);
      for (const entry of entries)
        await git(["update-index", "--add", "--cacheinfo", entry], index);
      return git(["write-tree"], index);
    };

    const base = await git([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${instance.baseCommit}^{commit}`,
    ]);
    const head = await git([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${instance.headCommit}^{commit}`,
    ]);
    const replayed = new Map<string, string>();
    replayed.set(
      base,
      await git([
        "commit-tree",
        "--no-gpg-sign",
        await withLearnings(base),
        "-p",
        base,
        "-m",
        "Add learnings",
      ]),
    );
    const range = await git(["rev-list", "--reverse", "--topo-order", `${base}..${head}`]);
    for (const commit of range.split("\n").filter((c) => c !== "")) {
      const object = await git(["cat-file", "commit", commit]);
      const rewritten = rewriteCommit(object, await withLearnings(commit), replayed);
      const path = join(scratch, "commit");
      await writeFile(path, rewritten);
      replayed.set(commit, await git(["hash-object", "-t", "commit", "-w", "--", path]));
    }
    const baseCommit = replayed.get(base) ?? base;
    const headCommit = replayed.get(head) ?? head;
    const ancestor = await exec("git", ["merge-base", "--is-ancestor", baseCommit, headCommit], {
      cwd: dir,
      env: GIT_ENV,
    });
    if (ancestor.exitCode !== 0)
      throw new Error(`${instance.baseCommit} is not an ancestor of the head`);
    return { baseCommit, headCommit };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// The commit as it was, on the new tree and the replayed parents; a
// signature would no longer match, so it is dropped.
export function rewriteCommit(
  object: string,
  tree: string,
  replayed: ReadonlyMap<string, string>,
): string {
  const end = object.indexOf("\n\n");
  const headers = end === -1 ? object : object.slice(0, end);
  const message = end === -1 ? "" : object.slice(end);
  const kept: string[] = [];
  let skipping = false;
  for (const line of headers.split("\n")) {
    if (line.startsWith(" ")) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = line.startsWith("gpgsig") || line.startsWith("mergetag");
    if (skipping) continue;
    if (line.startsWith("tree ")) kept.push(`tree ${tree}`);
    else if (line.startsWith("parent ")) {
      const parent = line.slice("parent ".length);
      kept.push(`parent ${replayed.get(parent) ?? parent}`);
    } else kept.push(line);
  }
  return `${kept.join("\n")}${message}`;
}

async function withProjectDocs(
  dir: string,
  id: string,
  args: readonly string[],
  projectDocs: readonly string[],
): Promise<string[]> {
  const at = args.indexOf("--config");
  const given = at === -1 ? undefined : args[at + 1];
  const config =
    given === undefined
      ? {}
      : (JSON.parse(await readFile(given, "utf8")) as Record<string, unknown>);
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  if (plugins.some((p) => typeof p !== "string" || !isAbsolute(p))) {
    throw new Error("a case's projectDocs need a configuration whose plugins are absolute paths");
  }
  const scratch = join(dir, ".git", "ocra-eval");
  await mkdir(scratch, { recursive: true });
  const file = join(scratch, `${id}.config.json`);
  await writeFile(file, `${JSON.stringify({ ...config, projectDocs }, null, 2)}\n`);
  const rest = at === -1 ? [...args] : [...args.slice(0, at), ...args.slice(at + 2)];
  return [...rest, "--config", file];
}
