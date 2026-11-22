import { mapWithConcurrency } from "../agent/pool.js";
import type { ReviewContext, SymbolExtractor } from "../contracts.js";
import type { FileDiff } from "../domain.js";
import type { Learning } from "../knowledge/learning.js";
import { learningSelector, type SelectLearnings } from "../knowledge/select.js";
import { changedCode } from "../review/impact.js";

// Characters of the code around one bundle's change that ranking reads.
const MAX_AROUND_CHARS = 50_000;
const READ_CONCURRENCY = 4;

// Each bundle's learnings, ranked with the code around its change where the
// limits leave a candidate out: only there does the ranking decide what a
// reviewer misses, so only there are the bundle's files read and parsed.
export async function bundleLearnings(
  learnings: readonly Learning[],
  bundles: readonly { files: readonly FileDiff[] }[],
  context: Pick<ReviewContext, "readFile" | "searchCode">,
  extractor: SymbolExtractor | undefined,
): Promise<SelectLearnings> {
  const select = learningSelector(learnings);
  if (!extractor) return select;
  const crowded = bundles.filter((b) => select(b.files).left.length > 0);
  const around = new Map<readonly FileDiff[], string>();
  await mapWithConcurrency(crowded, READ_CONCURRENCY, async ({ files }) => {
    around.set(files, await changedCode(files, context, extractor, MAX_AROUND_CHARS));
  });
  return (files, code) => select(files, code ?? around.get(files));
}
