import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { errorMessage } from "../errors.js";

const LEARNINGS_DIR = ".ocra/learnings";
export const MAX_LEARNING_CHARS = 16_000;
const MAX_BODY_CHARS = 4_000;
const MAX_LIST = 50;

const term = z.string().trim().min(1).max(200);

const learningSourceSchema = z.strictObject({
  kind: z.enum(["fix-commit", "review-feedback", "document", "remember", "manual"]),
  pr: z.number().int().positive().optional(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  url: z.url({ protocol: /^https?$/ }).optional(),
});

// Strict, so a misspelt key (`path:` for `paths:`) is refused rather than
// silently widening a learning to the whole repository. A critical learning
// is always shown where its paths match, so it must name them.
const learningFrontmatterSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    paths: z.array(term).min(1).max(MAX_LIST).optional(),
    symbols: z.array(term).min(1).max(MAX_LIST).optional(),
    keywords: z.array(term).min(1).max(MAX_LIST).optional(),
    critical: z.boolean().default(false),
    source: learningSourceSchema.optional(),
    created: z.iso.date().optional(),
  })
  .refine((l) => !l.critical || l.paths !== undefined, {
    message: "a critical learning must list its paths",
    path: ["paths"],
  });

export type Learning = z.infer<typeof learningFrontmatterSchema> & {
  // The file name without `.md`; unique within the directory.
  id: string;
  body: string;
};

export type ParsedLearning = { learning: Learning } | { warning: string };

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

// One file of LEARNINGS_DIR: YAML frontmatter, then the Markdown body. A
// file that does not parse is a warning, never a failed review.
export function parseLearning(path: string, text: string): ParsedLearning {
  const id = learningId(path);
  if (id === undefined) return { warning: `${path}: not a ${LEARNINGS_DIR}/*.md file` };
  if (text.length > MAX_LEARNING_CHARS) {
    return { warning: `${path}: longer than ${MAX_LEARNING_CHARS} characters` };
  }
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = FRONTMATTER.exec(normalized);
  if (!match) return { warning: `${path}: no YAML frontmatter between --- lines` };
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "", { maxAliasCount: 0 });
  } catch (error) {
    return { warning: `${path}: invalid YAML: ${errorMessage(error)}` };
  }
  const parsed = learningFrontmatterSchema.safeParse(data);
  if (!parsed.success) return { warning: `${path}: ${z.prettifyError(parsed.error)}` };
  const body = normalized.slice(match[0].length).trim();
  if (body.length === 0) return { warning: `${path}: the body is empty` };
  if (body.length > MAX_BODY_CHARS) {
    return { warning: `${path}: the body is longer than ${MAX_BODY_CHARS} characters` };
  }
  return { learning: { ...parsed.data, id, body } };
}

function learningId(path: string): string | undefined {
  const prefix = `${LEARNINGS_DIR}/`;
  if (!path.startsWith(prefix) || !path.endsWith(".md")) return undefined;
  const id = path.slice(prefix.length, -".md".length);
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) ? id : undefined;
}
