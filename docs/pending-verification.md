# Pending verification

Work that is merged and tested locally but still needs a check that could not be done yet. Each item says what unblocks it, what to check, and how. Delete an item once it is verified (and note the result in the PR or issue it belongs to).

## Site

Everything the site shows is verified on a local production build (2026-09-26): `npm run build && npx next start` in the site repository renders the manual from `../Open-CR-Agent/docs/manual`, so it shows exactly what a deploy would. Checked: every landing and manual page in both languages returns 200 and contains the new content, the Aqua gel icon and Apple touch icon, light and dark themes, and no horizontal overflow at 390 px. Repeat that check after site or manual changes instead of deploying.

The only thing a local build cannot show is the live site itself: https://ocra-nine.vercel.app shows the version from before the Vercel build limit was hit until the next deploy. Deploying is optional; when wanted, run `gh workflow run site-deploy.yml` here or deploy from the Vercel dashboard. The Vercel-side settings are already confirmed: site PR #7 created no preview build (only `main` deploys), and pushes to `main` that touch the manual cancel each other while waiting (debounce), so a burst costs one build.

## After a model key is available

Parked: the maintainer has no model API budget as of 2026-09-26 and will provide a key later. Work through this table in order once it is available.

| Item | Check | How |
|---|---|---|
| #12 baseline | Precision, recall and cost with a standard model stronger than flash-lite | `ocra-eval run --limit 20 --max-change-lines 300 --label baseline-<model> --reviewers correctness` |
| Security and performance reviewers (#52) | They add findings without dragging precision down | Same eval without `--reviewers`, compare with the baseline |
| Verify (#53) and Judge (#54) | Refuted and dropped findings are wrong ones; verdicts look right | Same eval with `verify`/`judge` on and off (`.ocra/config.json` in a scratch repo, or add eval flags) |
| `--ultra` (#62) | Recall rises, cost about doubles | Eval with `--ultra` passed through |
| #84 (B1) `ocra_` prompt tags | Precision and recall do not drop; fewer `file_level` findings on PRs touching HTML/XML (quotes no longer carry `‹title>`) | `ocra-eval run --limit 20 --max-change-lines 300 --label b1-tags` on the PR branch, compare with the baseline; merge #84 if it holds |
| #85 (B2) security reviewer at every tier | Cost on trivial PRs (about +1 task, ~2x first-prompt input) against security findings gained; precision holds. Recall side already measured for free: `ocra-eval ceiling` reachable security issues 13 → 16 of 18, overall 57.7% → 58.3% | `ocra-eval run --limit 20 --max-change-lines 300 --label b2-security-trivial` on the PR branch, per-tier cost from the report; merge #85 if it holds |
| #86 (B3) strict anchoring | Share of `file_level` findings and `anchoring.ambiguous`; precision rises or holds, matched findings are not lost | `ocra-eval run --limit 20 --max-change-lines 300 --label b3-anchoring` on the PR branch; merge #86 if it holds |
| Budget reserve (A4, `REVIEW_BUDGET_SHARE = 0.8`) | Verify + Judge stay within 20% of spend; runs that hit the limit still verify | Share of Verify/Judge usage in the eval reports above; run one with a low `--max-cost-usd` |
| Verification-gated verdict (A3) | How often critical findings are confirmed vs uncertain/unchecked; blocking verdicts match real criticals | Count `verification` per severity in the eval reports' findings |
| Re-review semantics (A2, A6) | `notReproduced` rate across two runs on the same head (model jitter); incremental runs cost less than full ones | Review the same PR twice with `ocra review --pr N`, then push one commit and review again |
| #67 GitHub Action on a live pull request | Inline positions (422 fallback), summary update in place, thread resolution permissions, fork behaviour; dismissals: `authorAssociation` and `resolvedBy` as the GraphQL API really returns them, the author's own resolve not dismissing, an outsider's "won't fix" not dismissing; incremental re-review: `IssueComment.editor` as GraphQL returns it for the Actions bot (null when never edited by a person) | Needs the key as a repository secret; ask the maintainer first |

## Before the first npm release

See [releasing.md](releasing.md): the maintainer decides the scope (`@open-cr-agent` needs an npm organization; `ocra` is free), the timing, and token vs trusted publishing. The packages are checked by `npm run check:packages` on every pull request, but only a real publish shows the registry page and `npx` behaviour.
