import { roleCall } from "../agent/settings.js";
import { answerQuestion } from "../chat/answer.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import { defaultSelectionPolicy, type SelectionPolicy, selectFiles } from "../select/select.js";
import type { Mention, VcsAdapter } from "../vcs.js";
import { reviewContext } from "./context.js";
import type { ReviewOptions } from "./options.js";

interface AnswerMentionOptions extends Pick<ReviewOptions, "effort" | "roles"> {
  vcs: VcsAdapter;
  mention: Extract<Mention, { asked: true }>;
  runtime: AgentRuntime;
  selection?: Partial<SelectionPolicy>;
  signal: AbortSignal;
  onUsage: (usage: Usage) => void;
}

// Answers a question in its thread from the files a review would select,
// read through the review's access policy: a question cannot reach a secret
// or a file the selection leaves out.
export async function answerMention(options: AnswerMentionOptions): Promise<void> {
  const { vcs, mention } = options;
  const diffs = await vcs.getDiff();
  const files = selectFiles(diffs, { ...defaultSelectionPolicy, ...options.selection })
    .filter((d) => d.selected)
    .map((d) => d.diff);
  const commented = mention.on && files.find((f) => f.newPath === mention.on?.path);
  const content = commented
    ? await reviewContext(vcs, diffs).readFile(commented.newPath)
    : undefined;
  const text = await answerQuestion(
    mention,
    {
      changeRequest: await vcs.getChangeRequest(),
      files,
      ...(content === undefined ? {} : { content }),
    },
    {
      runtime: options.runtime,
      signal: options.signal,
      onUsage: options.onUsage,
      call: roleCall("writer", options),
    },
  );
  await mention.answer(text);
}
