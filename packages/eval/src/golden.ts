import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { severitySchema } from "@open-cr-agent/core";
import { z } from "zod";
import type { Instance, ReferenceComment } from "./dataset.js";

// ADR-0011: cases ocra owns, one JSON file each, with the findings a review
// must report and the ranges where a finding is wrong.

export type GoldenTier = "smoke" | "full";

export interface ForbiddenRange {
  path: string;
  fromLine: number;
  toLine: number;
  reason: string;
}

export interface GoldenInfo {
  tier: GoldenTier;
  clean: boolean;
  forbid: ForbiddenRange[];
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

const caseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
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
          })
          .strict(),
      )
      .default([]),
    forbid: z
      .array(z.object({ file: pathSchema, lines: linesSchema, reason: z.string().min(1) }).strict())
      .default([]),
    clean: z.boolean().default(false),
  })
  .strict()
  .refine((c) => !c.clean || c.expect.length === 0, "a clean case cannot expect findings")
  .refine(
    (c) => c.clean || c.expect.length > 0 || c.forbid.length > 0,
    "a case needs expect, forbid or clean: true",
  );

export type GoldenCase = z.infer<typeof caseSchema>;

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
  const ids = new Set<string>();
  for (const file of files) {
    const golden = parseCase(JSON.parse(await readFile(join(dir, file), "utf8")), file);
    if (golden.id !== file.slice(0, -".json".length)) {
      throw new Error(`${file}: id "${golden.id}" does not match the file name`);
    }
    if (ids.has(golden.id)) throw new Error(`${file}: duplicate id "${golden.id}"`);
    ids.add(golden.id);
    instances.push(toInstance(golden));
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
    },
  };
}

// A case that points at a file the change does not touch was written against
// the wrong commits.
export function untouchedPaths(instance: Instance, changed: ReadonlySet<string>): string[] {
  if (!instance.golden) return [];
  const named = [
    ...instance.references.map((r) => r.path),
    ...instance.golden.forbid.map((f) => f.path),
  ];
  return [...new Set(named)].filter((p) => !changed.has(p));
}
