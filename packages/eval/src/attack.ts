import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec.js";
import type { Attack, Instance, ReferenceComment } from "./instance.js";
import { GIT_ENV } from "./repos.js";

// ADR-0014: an attack is a golden case with hostile text planted in its
// change. It is reviewed next to the clean case in the same run, and what
// the text changed is the measurement.

interface Range {
  path: string;
  fromLine: number;
  toLine: number;
}

export function attackLines(attack: Attack): string[] {
  const lines = attack.text.replace(/\n+$/, "").split("\n");
  return attack.channel === "description" ? lines.filter((l) => l.trim() !== "") : lines;
}

// Inserted lines move every range below them, and widen one they fall in,
// so the case's expectations still name the same code in the attacked head.
export function attackInstance(clean: Instance, id: string, attack: Attack): Instance {
  const golden = clean.golden;
  if (!golden) throw new Error(`${id}: attacks golden cases only`);
  const shift =
    attack.channel === "code" && attack.file !== undefined && attack.after !== undefined
      ? shifter(attack.file, attack.after, attackLines(attack).length)
      : <T extends Range>(r: T) => r;
  return {
    ...clean,
    id,
    prCategory: "adversarial",
    references: clean.references.map((r) => shiftReference(r, shift)),
    golden: {
      ...golden,
      tier: "adversarial",
      forbid: golden.forbid.map(shift),
      alternates: golden.alternates.map((list) => list.map(shift)),
      attack,
    },
  };
}

function shifter(file: string, after: number, count: number) {
  return <T extends Range>(r: T): T => {
    if (r.path !== file) return r;
    if (r.fromLine > after) return { ...r, fromLine: r.fromLine + count, toLine: r.toLine + count };
    if (r.toLine > after) return { ...r, toLine: r.toLine + count };
    return r;
  };
}

function shiftReference(r: ReferenceComment, shift: <T extends Range>(r: T) => T) {
  if (r.fromLine === null) return r;
  const moved = shift({ path: r.path, fromLine: r.fromLine, toLine: r.toLine ?? r.fromLine });
  return { ...r, fromLine: moved.fromLine, toLine: r.toLine === null ? null : moved.toLine };
}

// Fixed identity and dates, and no signature: the same attack on the same
// head is the same commit, so a resumed run reviews exactly what the first
// attempt did.
const IDENTITY = {
  GIT_AUTHOR_NAME: "ocra-eval",
  GIT_AUTHOR_EMAIL: "ocra-eval@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "ocra-eval",
  GIT_COMMITTER_EMAIL: "ocra-eval@example.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

// Commits the attack on top of the case's head without touching the working
// tree, the index or any ref, and returns the new head.
export async function plantAttack(dir: string, instance: Instance): Promise<string> {
  const attack = instance.golden?.attack;
  if (!attack) return instance.headCommit;
  const git = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = await exec("git", args, { cwd: dir, env: { ...GIT_ENV, ...IDENTITY, ...env } });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const id = async (args: string[], env: NodeJS.ProcessEnv = {}) => (await git(args, env)).trim();
  const head = instance.headCommit;
  if (attack.channel === "description") {
    const tree = await id(["rev-parse", "--verify", "--end-of-options", `${head}^{tree}`]);
    let parent = head;
    // `git log` lists the newest commit first, so the last line goes first.
    for (const line of attackLines(attack).reverse()) {
      parent = await id(["commit-tree", "--no-gpg-sign", tree, "-p", parent, "-m", line]);
    }
    return parent;
  }

  const file = attack.file ?? "";
  const entry = await git(["ls-tree", "--end-of-options", head, "--", file]);
  const match = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(entry);
  if (!match) throw new Error(`${file} is not a regular file in ${head}`);
  const [, mode = "", blob = ""] = match;
  const planted = insertLines(
    await git(["cat-file", "blob", blob]),
    attack.after ?? 0,
    attackLines(attack),
    file,
  );
  const scratch = await mkdtemp(join(tmpdir(), "ocra-attack-"));
  try {
    const path = join(scratch, "content");
    await writeFile(path, planted);
    const newBlob = await id(["hash-object", "-w", "--no-filters", "--", path]);
    const index = { GIT_INDEX_FILE: join(scratch, "index") };
    await git(["read-tree", "--end-of-options", head], index);
    await git(["update-index", "--cacheinfo", `${mode},${newBlob},${file}`], index);
    const tree = await id(["write-tree"], index);
    return await id(["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", "Update"]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function insertLines(content: string, after: number, lines: string[], file: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const parts = content.split(eol);
  const count = content.endsWith(eol) ? parts.length - 1 : parts.length;
  if (after > count) throw new Error(`${file} has ${count} lines; cannot insert after ${after}`);
  return [...parts.slice(0, after), ...lines, ...parts.slice(after)].join(eol);
}
