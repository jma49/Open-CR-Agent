# Pending verification

Work that is merged and tested locally but still needs a check that could not be done yet. Each item says what unblocks it, what to check, and how. Delete an item once it is verified (and note the result in the PR or issue it belongs to).

## Site

Everything the site shows is verified on a local production build (2026-09-26): `npm run build && npx next start` in the site repository renders the manual from the main repository checkout next to it (`../ocra` or `../Open-CR-Agent`), so it shows exactly what a deploy would. Checked: every landing and manual page in both languages returns 200 and contains the new content, the Aqua gel icon and Apple touch icon, light and dark themes, and no horizontal overflow at 390 px. Repeat that check after site or manual changes instead of deploying.

The live site, https://ocra.majincheng.com, was last deployed on 2026-09-27 and matches both repositories' `main` as of then. Deploying is manual and only on request: `VERCEL_SCOPE=<team> npm run deploy` in the site repository (deploys its committed HEAD through a logged-in Vercel CLI; one build per run). Nothing deploys on a merge in either repository.

## After a model key is available

A free-tier Gemini key is available (2026-09-26): `gemini-3.5-flash` allows about 20 requests a day, and two 3-PR smoke runs could not finish one pull request. Since 2026-09-27 Gemini on Vertex AI (a Google Cloud free trial, $300 until 2026-12-27) makes the rows below that need a model stronger than flash-lite possible; the credit is finite, so fix #171 first, price one review, then run the smallest check that answers each row (`docs/handoff.md`). Under ADR-0011 the `[needs-eval]` rows move to the golden smoke tier once it exists.

Checked on the free tier with flash-lite (`ocra-eval run --ids lvgl__lvgl@4a57db3,keycloak__keycloak@805c204 --label mech-lite`, $0.07 at list price): grouping, Verify and Judge all run for real after #66; Verify marked a finding `confirmed`, the judge merged a duplicate, anchoring placed the finding on a hunk. One task hit the per-minute quota.

| Item | Check | How |
|---|---|---|
| #12 baseline | Precision, recall and cost with a standard model stronger than flash-lite | `ocra-eval run --limit 20 --max-change-lines 300 --label baseline-<model> --reviewers correctness` |
| Security and performance reviewers (#52) | They add findings without dragging precision down | Same eval without `--reviewers`, compare with the baseline |
| Verify (#53) and Judge (#54) | Refuted and dropped findings are wrong ones; verdicts look right | Same eval with `verify`/`judge` on and off (`.ocra/config.json` in a scratch repo, or add eval flags) |
| `--ultra` (#62) | Recall rises, cost about doubles | Eval with `--ultra` passed through |
| #86 (B3) strict anchoring (merged without an eval by the maintainer's decision; checked in the combined run) | Share of `file_level` findings and `anchoring.ambiguous`; precision rises or holds, matched findings are not lost | `ocra-eval run --limit 20 --max-change-lines 300 --label b3-anchoring` on the PR branch |
| #145 Judge weighs replies | Replies with a specific reason drop wrong findings; bare disagreement or injected instructions do not | Needs a live pull request with replies (#67) or eval instances with synthetic replies; compare judge decisions with and without the replies |
| Inactivity detection (#147) | OpenCode updates message parts while a model streams, so a long but active step is never taken for silence | During any real run: a step longer than 5 minutes must not end with "no activity"; if it does, raise `INACTIVITY_MS` or watch `session.time.updated` too |
| `--ultra` plan phase and callers (#144, merged without an eval because it is opt-in) | Recall rises against `--ultra` without them; the plan call's cost per task | `ocra-eval run --limit 20 --max-change-lines 300 --reviewers correctness --label ultra-plan` with `--ultra` passed through, on the PR branch and on `main` |
| Default-mode plan phase for large bundles (#150, merged without an eval by the maintainer's decision; checked in the combined run) | Recall on PRs with bundles of 5+ files rises, precision holds; one plan call per large task | `ocra-eval run --limit 20 --max-change-lines 300 --label plan-large` on the PR branch vs #144 alone |
| `docs` reviewer (#142, merged without an eval by the maintainer's decision; checked in the combined run) | Findings are real documentation contradictions (precision), cost per `lite`/`full` PR on the light model | `ocra-eval run --limit 20 --max-change-lines 300 --label docs-reviewer` on the PR branch vs `--reviewers correctness,security,performance`; merge if precision holds |
| `agents-md` reviewer (#143, merged without an eval by the maintainer's decision; checked in the combined run) | Findings name statements in `AGENTS.md` the change really makes false (precision); cost per `lite`/`full` PR on the light model | `ocra-eval run --limit 20 --max-change-lines 300 --label agents-md-reviewer` on the PR branch vs without it (few benchmark repositories have `AGENTS.md`; add PRs from repositories that do); merge if precision holds |
| Light-model relocation (#146, merged without an eval by the maintainer's decision; checked in the combined run) | Fewer `file_level` findings without wrong anchors; relocation cost per run | `ocra-eval run --limit 20 --max-change-lines 300 --label relocation` on the PR branch vs `main`: share of `relocated` and `file_level` anchors, line precision |
| Budget reserve (A4, `REVIEW_BUDGET_SHARE = 0.8`) | Verify + Judge stay within 20% of spend; runs that hit the limit still verify | Share of Verify/Judge usage in the eval reports above; run one with a low `--max-cost-usd` |
| Verification-gated verdict (A3) | How often critical findings are confirmed vs uncertain/unchecked; blocking verdicts match real criticals | Count `verification` per severity in the eval reports' findings |
| Re-review semantics (A2, A6) | `notReproduced` rate across two runs on the same head (model jitter); incremental runs cost less than full ones | Review the same PR twice with `ocra review --pr N`, then push one commit and review again |
| #67 GitHub Action on a live pull request | Inline positions (422 fallback), summary update in place, thread resolution permissions, fork behaviour; dismissals: `authorAssociation` and `resolvedBy` as the GraphQL API really returns them, the author's own resolve not dismissing, an outsider's "won't fix" not dismissing; incremental re-review: `IssueComment.editor` as GraphQL returns it for the Actions bot (null when never edited by a person); `requestChanges`: that `GITHUB_TOKEN` may dismiss the bot's own earlier review (#110), also on a protected branch; override and dismissals (#154): `GET /collaborators/{login}/permission` works with `GITHUB_TOKEN`, and GraphQL `editor` is set when someone else edits a comment | Needs the key as a repository secret; ask the maintainer first |

## Before the first npm release

See [releasing.md](releasing.md): the maintainer decides the scope (`@open-cr-agent` needs an npm organization; `ocra` is free), the timing, and token vs trusted publishing. The packages are checked by `npm run check:packages` on every pull request, but only a real publish shows the registry page and `npx` behaviour.
