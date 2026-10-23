import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { isNotFound } from "@open-cr-agent/core/internal";
import { z } from "zod";
import { JUDGE_VERSION, type JudgeUsage, UnusableJudgeAnswer } from "./judges.js";
import type { SemanticJudge } from "./match.js";

export interface JudgeTally {
  questions: number;
  fromCache: number;
  // Scored as no match, and not cached.
  unusable: number;
}

// What one scoring asked of the judge and what it spent.
export type JudgeSpend = JudgeTally & JudgeUsage;

// Above this share of unusable answers the score is not worth reading.
const MAX_UNUSABLE_SHARE = 0.02;

const lineSchema = z.object({ key: z.string(), same: z.boolean() });

// What scoring asks the judge through. An answer is keyed by the judge's model
// and JUDGE_VERSION, so another judge or prompt never reuses it, and appended
// to the file as it arrives, so a scoring that fails or is stopped keeps what
// it paid for. An answer the judge could not give is scored as no match,
// counted, and not cached, so the next scoring asks again.
export class CachedJudge implements SemanticJudge {
  private cache = new Map<string, boolean>();
  private readonly counts: JudgeTally = { questions: 0, fromCache: 0, unusable: 0 };
  private firstUnusable = "";

  private readonly inner: SemanticJudge;
  private readonly path: string;
  private readonly judgeId: string;

  constructor(inner: SemanticJudge, path: string, judgeId: string) {
    this.inner = inner;
    this.path = path;
    this.judgeId = judgeId;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const line of text.split("\n")) {
      // A line cut short by a stopped scoring is asked again.
      const parsed = lineSchema.safeParse(parseOrUndefined(line));
      if (parsed.success) this.cache.set(parsed.data.key, parsed.data.same);
    }
  }

  async sameIssue(reference: string, generated: string): Promise<boolean> {
    this.counts.questions += 1;
    const key = createHash("sha256")
      .update(`${JUDGE_VERSION}\0${this.judgeId}\0`)
      .update(reference)
      .update("\0")
      .update(generated)
      .digest("hex")
      .slice(0, 32);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.counts.fromCache += 1;
      return cached;
    }
    let same: boolean;
    try {
      same = await this.inner.sameIssue(reference, generated);
    } catch (error) {
      if (!(error instanceof UnusableJudgeAnswer)) throw error;
      this.counts.unusable += 1;
      this.firstUnusable ||= error.message;
      return false;
    }
    this.cache.set(key, same);
    await appendFile(this.path, `${JSON.stringify({ key, same })}\n`);
    return same;
  }

  tally(): JudgeTally {
    return { ...this.counts };
  }

  // Scoring fails rather than report a score that too many missing answers
  // pulled down.
  checkAnswers(): void {
    const { questions, unusable } = this.counts;
    if (unusable <= questions * MAX_UNUSABLE_SHARE) return;
    throw new Error(
      `The judge gave no usable answer to ${unusable} of ${questions} questions, more than ${MAX_UNUSABLE_SHARE * 100}%, so the score would be wrong; score again to ask those again (the answers it gave are cached). First: ${this.firstUnusable}`,
    );
  }
}

function parseOrUndefined(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
