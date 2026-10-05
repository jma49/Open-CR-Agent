import { type IncompleteEnding, MAX_AGENT_STEPS } from "@open-cr-agent/core";

// What happened to files only partly reviewed, and what the user can do
// about it, one sentence per way their tasks ended. The exit message and the
// terminal report say the same thing. vcs-platform's summary says it in its
// own words, for a pull or merge request in Markdown, so the two evolve apart.
export function partlyReviewed(incomplete: Record<IncompleteEnding, number>): string[] {
  const lines: string[] = [];
  const intro = (n: number) =>
    `${n} selected file(s) were only partly reviewed, so the review is incomplete`;
  if (incomplete.step_cap > 0) {
    lines.push(
      `${intro(incomplete.step_cap)}: a reviewer used all ${MAX_AGENT_STEPS} of its steps before it finished them. The step limit is fixed; review a smaller change to give each file more of them.`,
    );
  }
  if (incomplete.stopped_early > 0) {
    lines.push(
      `${intro(incomplete.stopped_early)}: a reviewer stopped with steps left, without saying it had finished them. Run the review again, or use a stronger model if it keeps stopping.`,
    );
  }
  return lines;
}

export function partlyReviewedCount(incomplete: Record<IncompleteEnding, number>): number {
  return incomplete.step_cap + incomplete.stopped_early;
}
