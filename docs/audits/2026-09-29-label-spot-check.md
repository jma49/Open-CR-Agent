# Golden label spot-check, 2026-09-29

The golden set's precision depends on the labels in `evals/golden`: every reported finding that matches no expected issue is labeled valid or invalid against the code, and the label is stored with the case. All 11 labels so far were made by the AI agent working on ocra, and nobody had checked them. The maintainer asked for a spot-check by a second model instead of doing it by hand.

## Method

- **Sample.** 5 of the 11 labels: 3 valid, 2 invalid, from three repositories (ollama and ragflow pull requests from AACR-Bench, and one ocra commit). The agent that made the labels chose the sample to cover both labels, all three sources and the one critical finding. It was not drawn at random.
- **Reviewer.** Claude Fable 5.1, run as a separate agent with no context from this project's sessions.
- **Blind.** The reviewer got each finding (severity, title, file, lines, body, evidence and quoted code) with the repository, the base and head commits, and the pull request. It did not get the labels or their reasons, and it was told not to look for them.
- **Criterion**, the same one the labels used:
  - *valid*: a real defect in the code under review, including a minor or pre-existing one;
  - *invalid*: the claim is wrong, the code handles it elsewhere, or it has no practical consequence.
- **Evidence.** The reviewer read the code at the head commit and around it, looked for counter-evidence first, and cited the lines that decide each case. It was read-only.

## Results

| # | Finding | Label | Blind verdict | Confidence |
|---|---|---|---|---|
| 1 | ollama `server/create.go:99`: `errFilePath` missing from the base-files 400 list | valid | valid | medium |
| 2 | ollama `server/create.go:50`: no early validation of `r.Adapters` keys | invalid | invalid | medium |
| 3 | ollama `server/create.go:277`: a redundant create and delete per weight file | invalid | invalid | medium-high |
| 4 | ragflow `embed-modal/index.tsx:81`: `avatarHidden` and `locale` keys missing | valid | valid | high |
| 5 | ocra `context.ts:45`: symlinks bypass the read policy in workspace mode | valid | valid | high |

**The blind verdicts agree with all 5 labels.** The reviewer's notes add detail the labels did not record:

1. **Item 1 is real but narrower than the finding says.** `CreateHandler` already rejects POSIX traversal in `r.Files` with a 400 before this code runs. The gap is reachable through inputs that `validRelative` lets through and `os.Root` then rejects, such as Windows-style paths or NUL bytes, which come back as a 500. Only non-streaming clients see the status code, so "warning" overstates it.
2. **Item 2:** adapter keys skip the early check, but they touch the file system only inside `os.Root`, and the adapter branch maps that failure to a 400. The cost of failing late is negligible.
3. **Item 3:** the extra open is the containment check itself, and the `os.Remove` in `createLink` predates the pull request. It costs three system calls next to a conversion that reads every tensor.
4. **Item 4:** at the head commit, neither key exists in `en.ts`, and nothing in base..head touches a locale file (the pull request added the keys in a later commit). The labels render as raw keys. The reviewer also found, unprompted, the case's expected issue: `index.tsx` imports `languageOptions`, which `locales/config.ts` does not export at head.
5. **Item 5** was reproduced against a temporary repository. Links to `.git/config`, to `.env`, and a directory link into `.git` all passed the policy in workspace mode, and the contents came back. Commit and range reviews read link text through `git cat-file`, and pull request reviews had no file reads at that commit. So "critical" overstates it: the exposure is the local review or the model provider, not a public comment.

## What it changes

- The labels stand. Precision stays as published.
- Two of the three valid findings sampled carry a higher severity than the reviewer would give. Precision counts valid findings whatever their severity, and recall has a minimum severity per expected issue. Neither number changes, but the page's examples should not be read as severity-calibrated.
- The quality page now says that 5 of the 11 labels were re-judged blind by a second model, which agreed on all 5.

## Limits

- Five labels, chosen by the agent that made them.
- The reviewer is another AI model from the same vendor, not a person. It shares blind spots a human reviewer might not.
- Only the agent that wrote them has checked the 6 labels not sampled, or the 11 expected issues added from ocra's own findings. The one exception is the RAGFlow export, which the reviewer found on its own. The other 4 expected issues are bugs that ocra's history fixed.
