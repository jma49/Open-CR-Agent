# Pending verification

Work that is merged and tested locally but still needs a check that could not be done yet. Each item says what unblocks it, what to check, and how. Delete an item once it is verified (and note the result in the PR or issue it belongs to).

## After the next site deploy

The Vercel Hobby build limit was exhausted on 2026-09-26 ("retry in 24 hours"). Deploy with the site's Vercel dashboard, or `gh workflow run site-deploy.yml` in this repository, once it has reset.

| Item | Check | How |
|---|---|---|
| Aqua redesign and icon (site PRs #3, #4) | Landing page in light and dark, English and Chinese, at 390 px; favicon and Apple touch icon | Open https://ocra-nine.vercel.app and `/zh`; `/icon.svg`, `/apple-icon` |
| M2–M4 copy (site PRs #5, #6) | Matrix stage, Verify/Judge as shipped stages, roadmap M1–M4 shipped, terminal sample | Landing page, both languages |
| Manual pages added since the last successful deploy | New GitHub page, modes, memory, shared configuration, exit codes 3 and 130, security sections | `/docs/github`, `/docs/how-it-works#modes`, `/docs/cli`, `/docs/configuration`, `/docs/security`, and `/zh/docs/...` |
| Preview deployments off (site `vercel.json`) | A pull request on the site repository creates no Vercel deployment; `main` still deploys | Open a trivial PR and check its checks; confirm `**` matches branch names with `/` |
| Debounced deploy hook (`site-deploy.yml`) | Two manual changes merged within 30 minutes cause one site build | Actions tab: the first run is cancelled, the second deploys |

## After a model key is available

The Gemini key was removed from the maintainer's shell on 2026-09-26; see `docs/handoff.md`.

| Item | Check | How |
|---|---|---|
| #66 `complete()` on Gemini | Grouping, Verify and Judge calls succeed instead of failing safe | Probe script in the issue; run `ocra review` on a change with 4+ files and look for "grouping failed" |
| #12 baseline | Precision, recall and cost with a standard model stronger than flash-lite | `ocra-eval run --limit 20 --max-change-lines 300 --label baseline-<model> --reviewers correctness` |
| Security and performance reviewers (#52) | They add findings without dragging precision down | Same eval without `--reviewers`, compare with the baseline |
| Verify (#53) and Judge (#54) | Refuted and dropped findings are wrong ones; verdicts look right | Same eval with `verify`/`judge` on and off (`.ocra/config.json` in a scratch repo, or add eval flags) |
| `--ultra` (#62) | Recall rises, cost about doubles | Eval with `--ultra` passed through |
| #67 GitHub Action on a live pull request | Inline positions (422 fallback), summary update in place, thread resolution permissions, dismissals, fork behaviour | Needs the key as a repository secret; ask the maintainer first |
