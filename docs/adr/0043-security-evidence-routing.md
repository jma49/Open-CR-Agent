# ADR-0043: Security results go to the security reviewer

- Status: accepted
- Date: 2026-11-21

## Context

ADR-0042 shows every reviewer of a bundle every analyzer result on its files, and leaves routing by kind until an ablation shows the cost matters. A SAST rule's result is in only the security reviewer's focus, yet each other reviewer of the file reads it, weighs it and is told to leave it, at the price of tokens and of a finding filed in the wrong focus.

## Decision

1. **A result tagged `security` goes to the security reviewer** (a reviewer of category `security`) of its file, and not to the file's other reviewers.
2. **When no security reviewer reviews the file** (below its tier, ignored path, disabled, cut by the task limit), the result goes to every reviewer of the file, as before, so routing never drops a result.
3. **Untagged results go to every reviewer**, the security reviewer included: a tool that does not tag its rules gives no kind to route by.
4. Routing reads the run's matrix (`securityReviewed`), so `--plan` shows the prompts the run sends.

## Consequences

- A security-tagged result is read once per file instead of once per reviewer of it; results of a tool that tags nothing are routed as before.
- A correctness consequence of a security result (a crash, say) is left to the security reviewer to report.
- The ablation ADR-0042 asks for still applies to the source as a whole.
