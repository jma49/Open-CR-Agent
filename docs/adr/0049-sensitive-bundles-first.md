# ADR-0049: Run bundles on sensitive paths first

- Status: accepted; amends ADR-0015 decision 1
- Date: 2026-11-22

## Context

ADR-0015 keeps review tasks in plan order under a spend limit: bundle by bundle, every reviewer of a bundle before the next, so a limited run finishes whole files and the next review of the pull request continues with the rest. It rejected breadth first (no progress across pushes) and larger bundles first (no measurement favors it, and it spends the limit on fewer files).

Plan order is the order the bundler produced, which says nothing about risk. A pull request merged after its first push keeps only that first prefix of review, and a pull request whose authentication change sits in its last bundle gets its least important files reviewed first. Triage already names the paths that make a change risky (`auth/`, `PasswordHasher.cs`, CI workflows), but only to pick the run's tier.

## Decision

1. **The matrix lists bundles that touch a sensitive path first**, by triage's own test on each bundle's files (old and new paths), and keeps plan order within each group. A bundle's reviewers still run together, so ADR-0015's depth-first order and its progress across pushes are unchanged.
2. **One order for every limit.** The spend limit starts cells in this order, the task limit cuts by it after second samples and reviewer position, and `--plan` lists tasks in it, so what a user sees is what runs first.
3. **Task ids keep the bundle's position in the plan** (`correctness-3` stays the third bundle's), so resumed runs, session files and reports name the same tasks as before.

## Consequences

- A change without sensitive paths, or with every bundle on one, runs exactly as before. Prompts are unchanged, so this merges without an evaluation run, as ADR-0015's reporting change did.
- Under a spend limit, a limited run's reviewed prefix holds the sensitive bundles. The next review still continues with whatever is unfinished, in the same order.
- Sensitivity is one bit. Ranking further (by churn, source over tests) stays rejected until a measurement favors it; the sensitive-path list is triage's and changes with it.
