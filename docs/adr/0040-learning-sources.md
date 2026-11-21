# ADR-0040: Learning sources: `ocra learn`, one pipeline, written back by pull request

- Status: accepted
- Date: 2026-11-21

## Context

ADR-0037 made learnings files in `.ocra/learnings/` and left open where they come from. Four sources were decided, built in this order: lessons mined from fix commits, review feedback (what maintainers dismissed or accepted, and why), imported documents, and `@ocra remember` in a pull request. Each must write learnings that are small, correct and found again by the selection, without a person labelling anything, and a team must be able to require that a person approves each one.

Mining needs the repository's history and a model. The CLI has both on a laptop, in CI and in a self-hosted install; ocra Cloud has neither until hosted review exists (ADR-0026).

## Decision

1. **Sources live in the engine, as `ocra learn` commands** (`ocra learn mine` first). ocra Cloud, the Action and a self-hosted install run the same code rather than their own copies.
2. **One pipeline for every source:** the source yields candidates (its evidence: a fix's subject, message and diff; a dismissal and its reason), then:
   1. **Draft:** one call per candidate on the helper role (`core/src/knowledge/draft.ts`) turns the evidence into a title, a body, symbols and keywords, or declines when there is no lesson that would apply to other changes. The answer is validated: symbols must appear in the evidence, and the paths are not the model's but derived from the files the evidence touched.
   2. **Deduplicate:** a candidate whose source `ref` an existing learning already records is never drafted; a draft whose paths and title terms match an existing learning's is dropped.
   3. **Replay:** a draft is kept only if the selection (ADR-0037) gives it to the change it came from.
   4. **Write:** each kept draft becomes `.ocra/learnings/<id>.md` with `source` set, in the contract's format.
3. **Write-back is a pull request** that adds the files, set to merge automatically once its checks pass. `learnings.requireReview: true` in `.ocra/config.json` leaves it for a person to approve instead. Without a platform, `ocra learn` writes the files to the working tree.
4. **Every run is bounded:** at most `--max` candidates (default 20), each draft call under the run's spend limit, evidence cut to fixed sizes before it reaches the prompt, and every untrusted string neutralized (`data()`).

## Consequences

- A learning carries where it came from, so a wrong one is traced to its fix or comment and reverted like any file.
- Mining spends model calls; it is opt-in, bounded and reports its cost.
- The fix filters the evaluation's golden-case miner uses move to `vcs-local`, so both read history the same way.
- Replay checks only that the selection would find a learning, not that it is right; the automatic merge relies on the draft's validation and on the switch for teams that want a person in the loop.
