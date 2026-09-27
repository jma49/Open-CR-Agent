# Pending verification

Work that is merged and tested locally but still needs a check that could not be done yet. Each item says what unblocks it, what to check, and how. Delete an item once it is verified (and note the result in the PR or issue it belongs to).

## Site

Everything the site shows is verified on a local production build (2026-09-26): `npm run build && npx next start` in the site repository renders the manual from `../Open-CR-Agent/docs/manual`, so it shows exactly what a deploy would. Checked: every landing and manual page in both languages returns 200 and contains the new content, the Aqua gel icon and Apple touch icon, light and dark themes, and no horizontal overflow at 390 px. Repeat that check after site or manual changes instead of deploying.

The only thing a local build cannot show is the live site itself: https://ocra-nine.vercel.app shows the version from before the Vercel build limit was hit until the next deploy. Deploying is optional; when wanted, run `gh workflow run site-deploy.yml` here or deploy from the Vercel dashboard. The Vercel-side settings are already confirmed: site PR #7 created no preview build (only `main` deploys), and pushes to `main` that touch the manual cancel each other while waiting (debounce), so a burst costs one build.

## After a model key is available

Parked: the maintainer has no model API budget as of 2026-09-26 and will provide a key later. Work through this table in order once it is available.

| Item | Check | How |
|---|---|---|
| #66 `complete()` on Gemini | Grouping, Verify and Judge calls succeed instead of failing safe | Probe script in the issue; run `ocra review` on a change with 4+ files and look for "grouping failed" |
| #12 baseline | Precision, recall and cost with a standard model stronger than flash-lite | `ocra-eval run --limit 20 --max-change-lines 300 --label baseline-<model> --reviewers correctness` |
| Security and performance reviewers (#52) | They add findings without dragging precision down | Same eval without `--reviewers`, compare with the baseline |
| Verify (#53) and Judge (#54) | Refuted and dropped findings are wrong ones; verdicts look right | Same eval with `verify`/`judge` on and off (`.ocra/config.json` in a scratch repo, or add eval flags) |
| `--ultra` (#62) | Recall rises, cost about doubles | Eval with `--ultra` passed through |
| #67 GitHub Action on a live pull request | Inline positions (422 fallback), summary update in place, thread resolution permissions, fork behaviour; dismissals: `authorAssociation` and `resolvedBy` as the GraphQL API really returns them, the author's own resolve not dismissing, an outsider's "won't fix" not dismissing | Needs the key as a repository secret; ask the maintainer first |

## Before the first npm release

See [releasing.md](releasing.md): the maintainer decides the scope (`@open-cr-agent` needs an npm organization; `ocra` is free), the timing, and token vs trusted publishing. The packages are checked by `npm run check:packages` on every pull request, but only a real publish shows the registry page and `npx` behaviour.
