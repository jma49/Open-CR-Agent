import {
  LEARNINGS_DIR,
  type LearningFrontmatter,
  learningFrontmatterSchema,
  learningIdOf,
  MAX_LEARNING_BODY,
  MAX_LEARNING_BYTES,
  MAX_LEARNINGS,
  splitLearning,
} from "@open-cr-agent/cloud-contract";
import { errorMessage, type Learning } from "@open-cr-agent/core";
import { mapWithConcurrency } from "@open-cr-agent/core/internal";
import { parse } from "yaml";
import { z } from "zod";
import type { TrustedTree } from "./target.js";

const READ_CONCURRENCY = 8;

// A file that does not hold a valid learning is skipped with a warning: the
// files are written by people and by ocra Cloud, and one bad file must not
// stop a review (ADR-0037).
export async function loadLearnings(
  tree: TrustedTree,
  warn: (message: string) => void,
): Promise<Learning[]> {
  const listed = (await tree.listFiles(LEARNINGS_DIR)).filter((p) => p.endsWith(".md"));
  const named = listed.filter((path) => {
    if (learningIdOf(path)) return true;
    warn(`${path} is skipped: a learning's file name is lowercase letters, digits and hyphens`);
    return false;
  });
  if (named.length > MAX_LEARNINGS) {
    warn(
      `${LEARNINGS_DIR} holds ${named.length} learnings; only the first ${MAX_LEARNINGS} by name are read`,
    );
  }
  const paths = named.slice(0, MAX_LEARNINGS);
  const loaded = await mapWithConcurrency(paths, READ_CONCURRENCY, async (path) => {
    const text = await tree.readFile(path);
    if (text === undefined) return undefined;
    const parsed = parseLearning(text);
    if (typeof parsed === "string") {
      warn(`${path} is skipped: ${parsed}`);
      return undefined;
    }
    return toLearning(learningIdOf(path) ?? path, parsed);
  });
  return loaded.filter((l) => l !== undefined);
}

type Parsed = { frontmatter: LearningFrontmatter; body: string };

// The learning, or why the text is not one.
export function parseLearning(text: string): Parsed | string {
  if (Buffer.byteLength(text, "utf8") > MAX_LEARNING_BYTES) {
    return `it is larger than ${MAX_LEARNING_BYTES} bytes`;
  }
  const split = splitLearning(text);
  if (!split) return "it does not open with a --- frontmatter block";
  if (split.body.length === 0) return "its body is empty";
  if (split.body.length > MAX_LEARNING_BODY) {
    return `its body is longer than ${MAX_LEARNING_BODY} characters`;
  }
  let data: unknown;
  try {
    data = parse(split.frontmatter, { schema: "core", maxAliasCount: 0, uniqueKeys: true });
  } catch (error) {
    return `its frontmatter is not valid YAML: ${errorMessage(error)}`;
  }
  const frontmatter = learningFrontmatterSchema.safeParse(data);
  if (!frontmatter.success) {
    return `its frontmatter is invalid: ${z.prettifyError(frontmatter.error)}`;
  }
  return { frontmatter: frontmatter.data, body: split.body };
}

function toLearning(id: string, { frontmatter, body }: Parsed): Learning {
  const { title, paths, symbols, keywords, critical, source } = frontmatter;
  return {
    id,
    title,
    body,
    paths,
    symbols,
    keywords,
    critical,
    ...(source
      ? { source: { kind: source.kind, ...(source.ref ? { ref: source.ref } : {}) } }
      : {}),
  };
}
