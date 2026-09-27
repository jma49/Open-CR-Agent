# Full audit, 2026-09-27 (second)

A second full audit on the same day, after the first audit's fix round (#119–#152). It covers `main` at `d8cfe57` and the open pull requests. Five reviews ran in parallel, with no model calls: security; core correctness; GitHub integration, reliability and performance; documentation against code, architecture and tests; the open pull requests. Findings rated P1 or above were confirmed by a repro test, a CLI run, or by reading the code, as noted. Repros lived in a scratch directory and are not committed. The issues describe how to reproduce each finding.

Severity: **P0** exploitable or wrong in normal use · **P1** real weakness under realistic conditions · **P2** hygiene.

## Did the first audit's fixes hold?

Mostly. The symlink reads (#119), the summary-state trust (#122), the retries (#128), the tool caps (#129), the versioned outputs (#140, #152) and the session writer all hold, and their tests can fail. Three fixes have a gap:

- **Markdown (#125)**: link definitions inside containers still resolve (F5).
- **Dismissals (#127)**: a reply edited by someone else still counts (F2).
- **Override (#151)**: an edited comment counts, `author_association` is not write access, and a 7-character commit prefix can be matched by grinding a new commit (F2–F4).

## Findings on `main`

| # | Finding | Confirmed by | Sev | Issue |
|---|---|---|---|---|
| F1 | **A blocking verdict hides an incomplete review.** Exit 1 is returned before coverage is checked, and `action.yml` maps 1 to 0 by default, so a run with failed or unreviewed files passes CI. | code, repro | P1 | #153 |
| F2 | **Edited comments forge human commands.** `/ocra override` and decline replies are credited to the comment's original author, and anyone with write access can edit any comment. | code, GitHub permissions | P1 | #154 |
| F3 | **`author_association` is not write access.** `MEMBER` is any org member, and `COLLABORATOR` can be read-only. | GitHub docs | P1 | #154 |
| F4 | **An override binds to a 7-character commit prefix.** That is 28 bits, so an author can grind a commit that matches it. | code | P1 | #154 |
| F5 | **Link definitions inside a blockquote or list item bypass `safeMarkdown`**, so a bot comment can carry a deceptive link. | repro (markdown-it) | P1 | #155 |
| F6 | **A newline in a file path injects top-level text into Verify's prompt** (`File:` line). #126 fixes it. | repro | P1 | #155 |
| F7 | **Local reviews of untrusted code take `memory.json`, `rules.json` and `AGENTS.md` from that code**, even with `--no-repo-config`. A contributor can silence findings on their own change. | code | P1 | #156 |
| F8 | **A push between the two PR fetches publishes the new head for the old diff.** The next incremental run then skips the unreviewed commits. | repro | P1 | #157 |
| F9 | **Tasks cut by `maxTasks` leave their files counted as reviewed** (exit 0, not in `pending`). | repro | P1 | #153 |
| F10 | **`--ultra` with one failed sample exits 3** although coverage says every file was reviewed. | repro | P1 | #153 |
| F11 | **The judge can drop or downgrade a critical that Verify could not check**, so the run exits 0 instead of 3 (against #117). | repro | P1 | #153 |
| F12 | **The inactivity test "keeps writing" cannot fail**: its fake ignores the abort. | repro | P1 | #159 |
| F13 | **An override does not withdraw `requestChanges`.** | repro | P2 | #154 |
| — | About 40 lower-priority items: exit-code and render wording, cancellation in the action, GitHub edge cases, runtime and eval edge cases, output hygiene, secret patterns, test gaps, documentation drift, and output types that embed domain types. | read | P2 | #153, #155–#160 |

## Open pull requests

Each PR's findings are posted on the PR. In summary:

- **Needs changes**
  - **#85**: the `packages` check fails, because the smoke fixture now plans 2 tasks.
  - **#145**: findings flip between runs when a reply drops them. It must land after #126. It also needs a policy decision: should the PR author's arguments be able to drop unconfirmed findings?
- **Change when rebasing on #126**
  - **#142 and #143**: their prompts name the old tags, which #126 stops neutralizing. Nothing would fail if they merged unchanged.
- **Ready once evaluated, with P2 items**
  - **#86** and **#146**: the eval can't read their metrics, because `anchoring`/`relocated` are not in the versioned output.
  - **#146**: relocation is not budget-gated.
  - **#126**:
    - its tag regex is quadratic on long whitespace runs;
    - some Unicode look-alikes are not covered;
    - plugin tool results and tool errors are not neutralized;
    - `attribute()` escaping can break anchoring for paths containing `&`.
  - **#144**: the plan's cost is understated, and its sections are missing from the trust boundaries.
  - **#150**: stacked on #144; retarget it once #144 merges.
  - **#103**: misses some word forms.
- **#148** (CI baseline, not model-facing): ready. Two P2 items: `cancel-in-progress` also applies on `main`, and dependabot would bump the pinned OpenCode inside a grouped PR.

Merge order: **#126 first**, then #142/#143 renamed to its tags, #86 then #146, #144 then #150, and #145 last. #148 can merge any time. Every PR conflicts on `docs/pending-verification.md`. Evaluate each PR against the `main` it will merge into, in that order.

## Checked and fine

- **Structure.** Dependency direction is clean, no file is over 450 lines, and there are no TODO markers.
- **Pipeline order and verdict.** The pipeline order, the budget split and the verdict rubric match the documentation, and the judge's protection of confirmed criticals holds.
- **Interrupts and output.** Grace-period collection after an abort does not double count and cannot hang. `toReportOutput` and `toPlanOutput` map every field.
- **Local git.** Every git call has a timeout, reads and grep output are capped, and shallow clones give a clear hint.
- **Runtime.** The environment allowlist is in place, OpenCode binds to loopback with a password, and the MCP token is compared with `timingSafeEqual`.
- **Pull request trust.** Base-branch config, rules, memory and `AGENTS.md` are used for pull requests, and plugins never load.
- **Manual translations and timing tests.** The English and Chinese manuals agree except for one sentence. The timing tests are not flaky under CPU load.
