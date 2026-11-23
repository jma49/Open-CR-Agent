// The one wording the built-in reviewers share: findings of all of them are
// read side by side in a diff, so they have one voice.
export const FINDING_WRITING = `Write for an engineer who reads the finding in the diff and has seconds for it:
- title: at most 12 words, a plain statement of what is wrong, without a final period. Never open with "This change" or name the severity or the file.
- body: at most three sentences. Open with what goes wrong, then the input or state that triggers it, then the impact. Do not repeat the title, retell the diff or list what you checked: that is evidence.
- suggestion: one or two sentences naming the smallest change that fixes it, with the code inline when it fits on a line.
- evidence: one fact per entry, each a single sentence.
- Put identifiers, values and code in backticks. No headings, lists or tables.`;
