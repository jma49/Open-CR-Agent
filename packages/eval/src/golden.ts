import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@open-cr-agent/core";
import { isNotFound, severitySchema } from "@open-cr-agent/core/internal";
import { z } from "zod";
import { attackInstance } from "./attack.js";
import { ATTACK_CHANNELS, ATTACK_GOALS, type Instance, type ReferenceComment } from "./instance.js";

// ADR-0011: cases ocra owns, one JSON file each, with the findings a review
// must report and the ranges where a finding is wrong.

// Golden cases name ocra's reviewers; scoring and the ceiling speak
// AACR-Bench's category names.
export const REFERENCE_CATEGORY = {
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

// ADR-0036: a case stores ids, paths, line ranges and ocra's own sentence,
// so any OSI licence will do, copyleft included. Source-available licences
// (Sustainable Use, Timescale, BUSL, SSPL or ELv2 alone) are not on the list;
// for a choice of licences, the case records the OSI option.
const LICENCES = [
  "0BSD",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "EPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "ISC",
  "LGPL-2.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "PHP-3.01",
  "PostgreSQL",
  "Python-2.0",
  "Unlicense",
  "Zlib",
] as const;

// Where a claim came from (ADR-0036). author-fix wins whenever upstream later
// fixed the code: the fix is the strongest evidence that the claim is real.
const CLAIM_ORIGINS = [
  "human-review",
  "author-fix",
  "ai-reference-vetted",
  "model-found-vetted",
  "maintainer",
] as const;

// Per case, so no case can dominate a tier's recall or precision.
const MAX_REQUIRED_CLAIMS = 3;
const MAX_OPTIONAL_CLAIMS = 5;
const MAX_FORBID_RANGES = 3;

// The head commit's date, for splitting metrics at a model's training cutoff.
const dateSchema = z.iso.date();
const claimIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be a short kebab-case slug")
  .max(40);

// SPDX's word for a licence nobody determined: what an imported candidate
// carries until someone checks it. No case loads with it.
export const UNCHECKED_LICENCE = "NOASSERTION";

const candidateSchema = z
  .object({
    id: idSchema,
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/name on GitHub"),
    base: commitSchema,
    head: commitSchema,
    language: z.string().min(1),
    tier: z.enum(["smoke", "full"]),
    source: z
      .object({
        kind: z.enum(["ocra-history", "dogfood", "aacr", "github", "reviewbench"]),
        ref: z.string().min(1),
        licence: z.enum([...LICENCES, UNCHECKED_LICENCE]),
        date: dateSchema,
      })
      .strict(),
    rationale: z.string().min(1),
    // Who vetted the case and when; the second rater of ADR-0036's protocol.
    raters: z.array(z.object({ by: z.string().min(1), date: dateSchema }).strict()).optional(),
    expect: z
      .array(
        z
          .object({
            // Stable within the case: scores, the ceiling and trends pair
            // claims by it, never by position.
            id: claimIdSchema,
            file: pathSchema,
            lines: linesSchema,
            category: z.enum(["correctness", "security", "performance"]),
            minSeverity: severitySchema,
            concern: z.string().min(1),
            also: z.array(z.object({ file: pathSchema, lines: linesSchema }).strict()).default([]),
            origin: z.enum(CLAIM_ORIGINS),
            // "human", a model id, or a tool.
            producer: z.string().min(1),
            // Real, but outside what the reviewers are asked to report, or
            // not vetted enough to require: a match counts for precision,
            // never for recall.
            optional: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
    forbid: z
      .array(z.object({ file: pathSchema, lines: linesSchema, reason: z.string().min(1) }).strict())
      .max(MAX_FORBID_RANGES)
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
  )
  .refine(
    (c) => new Set(c.expect.map((e) => e.id)).size === c.expect.length,
    "claim ids are unique within a case",
  )
  .refine(
    (c) => c.expect.filter((e) => !e.optional).length <= MAX_REQUIRED_CLAIMS,
    `a case has at most ${MAX_REQUIRED_CLAIMS} required claims`,
  )
  .refine(
    (c) => c.expect.filter((e) => e.optional).length <= MAX_OPTIONAL_CLAIMS,
    `a case has at most ${MAX_OPTIONAL_CLAIMS} optional claims`,
  );

const caseSchema = candidateSchema.refine((c) => c.source.licence !== UNCHECKED_LICENCE, {
  message: "check the repository's licence at head and record one from the allowlist",
  path: ["source", "licence"],
});

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

type AttackCase = z.infer<typeof attackCaseSchema>;

function isAttackCase(data: unknown): boolean {
  return typeof data === "object" && data !== null && "attack" in data;
}

function parseAttackCase(data: unknown, source: string): AttackCase {
  const result = attackCaseSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${source}: ${issue?.path.join(".") || "case"}: ${issue?.message}`);
  }
  return result.data;
}

export function parseCase(data: unknown, source: string): GoldenCase {
  return parseWith(caseSchema, data, source);
}

// What golden-import writes: a case whose licence nobody has checked yet.
export function parseCandidate(data: unknown, source: string): GoldenCase {
  return parseWith(candidateSchema, data, source);
}

function parseWith(schema: typeof caseSchema, data: unknown, source: string): GoldenCase {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${source}: ${issue?.path.join(".") || "case"}: ${issue?.message}`);
  }
  return result.data;
}

export async function loadGolden(dir: string): Promise<Instance[]> {
  const entries = await readdir(dir).catch((error: unknown) => {
    if (isNotFound(error)) throw new Error(`No golden cases: ${dir} does not exist`);
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
      claims: golden.expect.map((e) => ({ id: e.id, optional: e.optional })),
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
    throw new Error(`${label}: not valid JSON (${errorMessage(error)})`);
  }
}
