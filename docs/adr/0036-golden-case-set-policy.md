# ADR-0036: Golden case set policy: sources, provenance, licences, vetting and caps

- Status: accepted; amends [ADR-0011](0011-golden-eval-set.md) points 1, 2, 3 and 5 and [ADR-0014](0014-adversarial-golden-cases.md) point 4
- Date: 2026-10-23
- Reviewed with: Claude Fable 5.1, 2026-10-23 (16 findings; 1–16 applied or answered in the PR)

## Context

ADR-0011 put merge decisions on a golden set ocra owns. On 2026-10-23 it held 16 cases with 27 expected findings, and a read-only audit of the set and of the AACR-Bench candidate pipeline found it could not carry the decisions it was meant for:

- **The references are not what ADR-0011 says.** It calls AACR-Bench's references "the comments human reviewers happened to leave". The dataset's `is_ai_comment` is true for 1,597 of its 2,145 rows (74%) and for 709 of the 879 in ocra's scope; the models named are GPT-5.2, Claude 4.5 Sonnet, Qwen-Coder-480B, GLM-4.7, DeepSeek-V3.2 and Gemini 3 Pro. In the first vetting batch, 7 of 12 comments written by people survived a check against the code (58%), and 2 of 16 written by models (12.5%).
- **Some expectations contradict the reviewers' instructions.** The correctness reviewer is told to skip "anything a linter, formatter or compiler reports reliably" and "issues in unchanged code that this change does not make reachable or worse" (`correctness.ts`). Three expectations are build failures and two are pre-existing code outside the change, so a review that follows its prompt misses them.
- **Promotion had no bar.** Seven expectations were a model's finding title copied verbatim after one label, mostly at suggestion level, several found in a single run and never again; a comparable pre-existing finding elsewhere was labelled valid and not promoted.
- **Two cases dominated.** Ollama and coverage-gaps held 10 of the smoke tier's 18 expectations.
- **Nothing recorded provenance.** Licence and check date lived as free text in `source.ref`; no field recorded when the code was written, who made a claim, or where it came from. Whether copyleft code (FreeCAD's LGPL, Elasticsearch's AGPL option) or source-available licences may be used had never been decided.
- **Claims had no identity.** The ceiling baseline keyed an expectation as the n-th on its path, trend and compare paired claims by position, so reordering a case moved every key after it.
- **Seven AACR cases pinned a `base` that is not an ancestor of `head`**, against step 2 of `evals/golden/README.md`. Reviews and the ceiling take the merge base, so nothing was mis-measured, but the files said otherwise.

The evaluation standard (metrics, inference, merge rule, judge, tiers) is a separate record, to be written as ADR-0035. This one is the case set.

## Decision

1. **Sources, in priority order** (amends ADR-0011 point 5):
   1. **AACR-Bench comments written by people** (`is_ai_comment` false). All predate current models' training cutoffs, so they go to the public tiers only. A comment written by a model may still become a claim after vetting (origin `ai-reference-vetted`), at a lower priority.
   2. **Fresh pull requests for the held-out tier**: a human review comment that led to an author fix, in a change merged after the later of the reviewer's and the judge's published training cutoffs. Mined with `gh` later, kept private (`../ocra-internal`), never in this repository.
   3. **ocra's own history**: at most 30% of the smoke tier's required claims, and never held out, since the repository and its fix commits are public.
   4. **`forbid` seeds**: AACR-Bench comments labelled incorrect (label 0) and findings the maintainer dismissed.
   5. **ReviewBench** (MIT): its manifest and golden findings are public, so it is never held out, and its true positives are model-written. Findings from people, tools and non-Claude producers go first, its severity labels are ignored, every claim is in ocra's own words, and this round takes at most 10 pull requests.
2. **Provenance is recorded in the schema** (amends ADR-0011 point 1). `source.kind` gains `github` and `reviewbench`; `source.licence` is an SPDX id and `source.date` the head commit's date. Each claim in `expect` has an `id` (a short slug, stable within the case), an `origin` (`human-review`, `author-fix`, `ai-reference-vetted`, `model-found-vetted` or `maintainer`), a `producer` (`human`, a model id, or a tool) and `optional`. A case may record `raters` (`by`, `date`). When upstream later fixed the code, the origin is `author-fix` whoever first stated the claim, since the fix is the strongest evidence; the producer still names who first stated it. A fix ocra's maintainer made because an ocra run reported the issue does not count: it acts on the finding rather than confirming it independently, so the origin stays `model-found-vetted`. When a run did not record which model stated a claim, the producer says so (for example `claude (version not recorded)`).
3. **Licences.** A case stores only ids, paths, line ranges and ocra's own one-sentence concern, never quoted code or comments. The schema holds an allowlist of OSI licences, copyleft included, extended when a case needs another OSI licence; a test refuses anything else. A choice of licences records its OSI option (Elasticsearch's AGPL-3.0-only). The Sustainable Use License, the Timescale License, BUSL, and code under SSPL or ELv2 alone are never added. `golden-import` records the licence when the repository's root files at `head` (licence texts and package metadata) agree on one allowlisted licence, and `NOASSERTION` otherwise, which no case loads with; its candidates stay "not hand-checked" until vetted, and vetting confirms the licence.
4. **Contamination.** Every case records `source.date`. Metrics are to be split before and after the training cutoff and by source (with the reporting the evaluation standard adds; the split is confounded with the source, and reports say so). Held-out ids and model output on held-out cases never appear in public.
5. **Vetting protocol.** A claim is kept only when it is true at `head` (checked against callers and callees), inside the reviewers' contract with a stated consequence, at most 15 lines with `also` for alternate locations, and one sentence in ocra's own words with a conservative `minSeverity`. The schema enforces the 15 lines for required claims; for optional ones it is a review check. Then:
   - if upstream later fixed the code, the origin is `author-fix`; if upstream kept the behaviour, the claim becomes optional or is dropped;
   - claims outside the reviewers' contract become optional, and the prompts stay as they are: what a compiler or build reports, and pre-existing code the change does not make reachable or worse;
   - claims only a model vouches for (origin `model-found-vetted` or `ai-reference-vetted`) are optional; one becomes required only when a second rater agrees, it is in the diff, its severity is warning or above, and it was found in at least 2 runs. The schema refuses such a claim as required at `suggestion`, and `golden-import` writes a comment a model wrote as optional. A vetter may also keep a real claim optional until the second rater has seen it, which is how a claim being vetted again is kept; nothing but this protocol makes a claim required;
   - vetting is blind: vetting agents get no access to `.ocra/eval` or any run directory, and case files are committed, and so hashed, before any run over them is scored;
   - a blind second rater re-vets every held-out claim and every open call, and 30% of the others; below 85% keep/drop agreement the whole batch is vetted again, and disagreements go to the maintainer, who also blind-checks a random sample of kept claims.
   A claim is retired for a vetting defect, never for being missed; one being vetted again stays in its case with a note in the rationale.
6. **Optional claims are scored for precision only** (amends ADR-0011 point 3, recall measured on `expect`, and ADR-0014 point 4). They leave both the numerator and the denominator of recall, and a finding that matches one counts as correct, not as noise. Required claims are matched first, so an optional one never takes a finding a required one would match. The ceiling, the recall funnel and compare's sign test cover required claims; trend lists optional ones, marked, since repeated finds are what promote one. An attack counts every claim of the case it attacks, optional ones included: it asks whether planted text hid a finding, not what recall requires.
7. **Caps per case:** at most 3 required claims, 5 optional ones and 3 `forbid` ranges, enforced by the schema, so no case dominates a tier.
8. **Claims are identified by id.** The ceiling baseline keys a claim as `<case> <id>`; trend and compare pair claims by id across runs, and the cases' hash takes claims in id order, so reordering a case's claims changes nothing. A run scored before claims had ids is refused by compare's paired test and left out of trend's claim table, with a note to rescore it.
9. **`base` is the merge base of the change**, as step 2 of `evals/golden/README.md` says; the seven AACR pins that were not ancestors of their heads are normalized (the diff `base...head` is unchanged).
10. **`adjudicate` adds a valid finding as an optional claim** (amends ADR-0011 point 2, where it became an expectation): `origin` `model-found-vetted`, `producer` `ocra (model not recorded)`, since a run does not record which model reported it. Making it required is a vetting decision under point 5, made by hand in a curation pull request. A finding that would pass the cap of optional claims is refused, naming the case, so it is merged into an existing claim's `also` or waits for vetting.
11. **The 16 existing cases are dispositioned once**, in the same change as the schema so that the cases' hash breaks once, after checking each claim against the code at `head` and upstream's later history. Each case's `rationale` records what was decided for it and why, and its `raters` records this check as not blind: it read earlier runs and labels. The second rater for these cases is blind.

| Case | Disposition |
|---|---|
| keycloak, elasticsearch, loose-dismissal, override-trust, sessions-gitignore | Kept. Every claim was fixed later upstream or in ocra (`author-fix`) |
| judge-downgrade | Kept, the 67-line range narrowed to the 6 lines that allow the downgrade, with the loop that applies it and the test that asserts it as `also` |
| aspnetcore | Optional: outside the change, found only by a model, and upstream still runs the public image on that line |
| lvgl | The claim is retired for a vetting defect: with `LV_TEXT_FLAG_EXPAND` the cached width is never used, so nothing is laid out at width 0. The case becomes forbid-only on that range |
| codex #1, freecad #1, ragflow #1 | Optional: the compiler reports them. freecad stays the host of two attacks |
| ollama #3, coverage-gaps #4 | Optional: outside the change or pre-existing |
| ollama #4 (files-omitted-error) | Required: true at head, in the change, fixed by the author's next commit (`author-fix`), and rewritten in ocra's words |
| ollama #5 (nested-test-case) | Optional: also `author-fix`, but a test exercising inputs production never sends is minor, found in one run, and waits for the second rater |
| coverage-gaps #3 and #5 | Merged (one range, one fingerprint) into one optional claim |
| ollama #2, coverage-gaps #2, index-copy | Optional and marked in the rationale for vetting again, until the second rater has seen them. ollama #2 also fails point 5 on its own: only a model's reference vouches for it, at suggestion, and upstream kept the gap; its range is narrowed to the separator checks |
| ollama fingerprint 165fe552 | Both labels stay: they are two claims on the same code (ADR-0012), and a label applies to its own title first |
| ragflow #2 | Rewritten in ocra's words |
| codex #1 | Also narrowed to the first test initializer, the second as `also` |
| gofr | Forbid-only, as before |
| steps-clean | Clean, as before; its earlier findings are still to be labelled |

## Consequences

- `casesHash` changes for every case. Golden numbers scored before this record are not comparable with numbers scored after it, and the published ones say so. Summaries written before claims had ids cannot be paired claim by claim; rescore them.
- The full tier keeps 16 cases with 14 required claims (from 27 expectations), 11 optional claims and 2 `forbid` ranges; the smoke tier has 10 cases with 7 required claims. Every required claim is reachable by the deterministic stages (`evals/ceiling-baseline.json`).
- The smoke tier meets the 30% cap on ocra's history at acceptance (2 of its 7 required claims). If a later change puts it over, it may stay over only until the next AACR batch lands, and never at a gated run.
- Candidates imported before this change do not load; import them again. Candidates now say whose comment each claim restates, and need a licence before they move into `evals/golden/`.
- Every claim added from now on costs a little more to write (id, origin, producer), in exchange for recall reported by origin and by producer, with and without claims made by Claude models.
