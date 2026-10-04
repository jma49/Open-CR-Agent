import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Severity } from "@open-cr-agent/core";
import { severitySchema } from "@open-cr-agent/core/internal";
import { z } from "zod";
import { ATTACK_CHANNELS, ATTACK_GOALS, type Attack, attackInstance } from "./attack.js";
import type { Instance, ReferenceComment } from "./dataset.js";

// ADR-0011: cases ocra owns, one JSON file each, with the findings a review
// must report and the ranges where a finding is wrong.

export type GoldenTier = "smoke" | "full" | "adversarial";

export interface ForbiddenRange {
  path: string;
  fromLine: number;
  toLine: number;
  reason: string;
}

export interface Adjudication {
  fingerprint: string;
  label: "valid" | "invalid";
  reason: string;
  title: string;
}

export interface Location {
  path: string;
  fromLine: number;
  toLine: number;
}

export interface GoldenInfo {
  tier: GoldenTier;
  clean: boolean;
  forbid: ForbiddenRange[];
  adjudicated: Adjudication[];
  // The lowest severity that counts, one per reference, in their order.
  minSeverity: Severity[];
  // Other places the same issue can rightly be reported (the docs that
  // promise a behavior, the test that misses it), one list per reference.
  alternates: Location[][];
  // Set on an adversarial case: the hostile text planted in the case it names.
  attack?: Attack;
}

// Golden cases name ocra's reviewers; scoring and the ceiling speak
// AACR-Bench's category names.
const REFERENCE_CATEGORY = {
  correctness: "Code Defect",
  security: "Security Vulnerability",
  performance: "Performance",
} as const;

// Paths reach git and the file system: repository-relative, no way out.
const pathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !/[\\\0]/.test(p) &&
      !p.split("/").some((s) => s === ".." || s === "" || s === "."),
    "must be a relative path inside the repository",
  );
const linesSchema = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .refine(([from, to]) => from <= to, "must be [from, to] with from <= to");
// Commit ids reach git as arguments; anything else could be read as an option.
const commitSchema = z.string().regex(/^[0-9a-f]{7,64}$/);
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);

const caseSchema = z
  .object({
    id: idSchema,
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/name on GitHub"),
    base: commitSchema,
    head: commitSchema,
    language: z.string().min(1),
    tier: z.enum(["smoke", "full"]),
    source: z
      .object({ kind: z.enum(["ocra-history", "dogfood", "aacr"]), ref: z.string().min(1) })
      .strict(),
    rationale: z.string().min(1),
    expect: z
      .array(
        z
          .object({
            file: pathSchema,
            lines: linesSchema,
            category: z.enum(["correctness", "security", "performance"]),
            minSeverity: severitySchema,
            concern: z.string().min(1),
            also: z.array(z.object({ file: pathSchema, lines: linesSchema }).strict()).default([]),
          })
          .strict(),
      )
      .default([]),
    forbid: z
      .array(z.object({ file: pathSchema, lines: linesSchema, reason: z.string().min(1) }).strict())
      .default([]),
    clean: z.boolean().default(false),
    // The maintainer's verdict on findings that matched no expect entry,
    // recorded once per fingerprint so no run has to guess.
    adjudicated: z
      .array(
        z
          .object({
            fingerprint: z.string().regex(/^[0-9a-f]{8,64}$/),
            label: z.enum(["valid", "invalid"]),
            reason: z.string().min(1),
            title: z.string(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .refine((c) => !c.clean || c.expect.length === 0, "a clean case cannot expect findings")
  .refine(
    (c) =>
      new Set(c.adjudicated.map((a) => `${a.fingerprint}\0${a.title}`)).size ===
      c.adjudicated.length,
    "a claim on the same code (fingerprint and title) is labeled once",
  )
  .refine(
    (c) => c.clean || c.expect.length > 0 || c.forbid.length > 0,
    "a case needs expect, forbid or clean: true",
  );

export type GoldenCase = z.infer<typeof caseSchema>;

// An attack takes its repository, commits and expectations from the case it
// names (`on`), so the two differ only by the planted text.
const attackCaseSchema = z
  .object({
    id: idSchema,
    tier: z.literal("adversarial"),
    rationale: z.string().min(1),
    attack: z
      .object({
        on: idSchema,
        goal: z.enum(ATTACK_GOALS),
        channel: z.enum(ATTACK_CHANNELS),
        text: z.string().min(1).max(4000),
        file: pathSchema.optional(),
        after: z.number().int().nonnegative().optional(),
        canary: z.string().min(1).optional(),
      })
      .strict()
      .refine(
        (a) =>
          a.channel === "code"
            ? a.file !== undefined && a.after !== undefined
            : a.file === undefined && a.after === undefined,
        "a code attack names file and after; a description attack names neither",
      )
      .refine(
        (a) => a.goal === "suppress" || (a.canary !== undefined && a.text.includes(a.canary)),
        "a plant-link or forge-command attack needs a canary that its text contains",
      ),
  })
  .strict();

export type AttackCase = z.infer<typeof attackCaseSchema>;

function isAttackCase(data: unknown): boolean {
  return typeof data === "object" && data !== null && "attack" in data;
}

export function parseAttackCase(data: unknown, source: string): AttackCase {
  const result = attackCaseSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${source}: ${issue?.path.join(".") || "case"}: ${issue?.message}`);
  }
  return result.data;
}

export function parseCase(data: unknown, source: string): GoldenCase {
  const result = caseSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${source}: ${issue?.path.join(".") || "case"}: ${issue?.message}`);
  }
  return result.data;
}

export async function loadGolden(dir: string): Promise<Instance[]> {
  const entries = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`No golden cases: ${dir} does not exist`);
    throw error;
  });
  const files = entries.filter((f) => f.endsWith(".json")).sort();
  const instances: Instance[] = [];
  const attacks: { file: string; attack: AttackCase }[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const data = await readJson(join(dir, file), file);
    const parsed = isAttackCase(data) ? parseAttackCase(data, file) : parseCase(data, file);
    if (parsed.id !== file.slice(0, -".json".length)) {
      throw new Error(`${file}: id "${parsed.id}" does not match the file name`);
    }
    if (ids.has(parsed.id)) throw new Error(`${file}: duplicate id "${parsed.id}"`);
    ids.add(parsed.id);
    if ("attack" in parsed) attacks.push({ file, attack: parsed });
    else instances.push(toInstance(parsed));
  }
  const cases = new Map(instances.map((i) => [i.id, i]));
  for (const { file, attack } of attacks) {
    const clean = cases.get(attack.attack.on);
    if (!clean) throw new Error(`${file}: attacks "${attack.attack.on}", which is not a case`);
    instances.push(attackInstance(clean, attack.id, attack.attack));
  }
  return instances;
}

export function toInstance(golden: GoldenCase): Instance {
  return {
    id: golden.id,
    repo: golden.repo,
    prUrl: `https://github.com/${golden.repo}/compare/${golden.base}...${golden.head}`,
    language: golden.language,
    prCategory: golden.source.kind,
    baseCommit: golden.base,
    headCommit: golden.head,
    // Unknown until the repository is cloned; --max-change-lines does not apply.
    changeLines: 0,
    references: golden.expect.map(
      (e): ReferenceComment => ({
        path: e.file,
        side: "right",
        fromLine: e.lines[0],
        toLine: e.lines[1],
        note: e.concern,
        category: REFERENCE_CATEGORY[e.category],
        context: "",
      }),
    ),
    golden: {
      tier: golden.tier,
      clean: golden.clean,
      forbid: golden.forbid.map((f) => ({
        path: f.file,
        fromLine: f.lines[0],
        toLine: f.lines[1],
        reason: f.reason,
      })),
      adjudicated: golden.adjudicated,
      minSeverity: golden.expect.map((e) => e.minSeverity),
      alternates: golden.expect.map((e) =>
        e.also.map((a) => ({ path: a.file, fromLine: a.lines[0], toLine: a.lines[1] })),
      ),
    },
  };
}

// A case that points at a file the change does not touch was written against
// the wrong commits.
export function untouchedPaths(instance: Instance, changed: ReadonlySet<string>): string[] {
  if (!instance.golden) return [];
  const named = [
    ...instance.references.map((r) => r.path),
    ...instance.golden.alternates.flat().map((a) => a.path),
    ...instance.golden.forbid.map((f) => f.path),
  ];
  return [...new Set(named)].filter((p) => !changed.has(p));
}

export async function readJson(path: string, label = path): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: not valid JSON (${(error as Error).message})`);
  }
}
