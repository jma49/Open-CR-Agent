# Changelog

Changes to the `@open-cr-agent/*` packages and the GitHub Action. The packages are released together at one version. While that version is 0.x, a minor release may change options, configuration and output; each such change is listed here.

## 0.1.0

The first release of ocra (Open-CR-Agent), an open-source multi-agent code reviewer for local changes and GitHub pull requests. It is early: it has been measured on a small set of cases, with one family of models, and options may still change. Read [what reviews find and miss](https://ocra.majincheng.com/en/docs/quality) before you rely on it.

### Install

```bash
npm install -g @open-cr-agent/cli
ocra --version
```

Requires Node.js 22.19 or newer and Git. Reviews run on [OpenCode](https://opencode.ai), which is installed with ocra, and on the models you choose from any provider OpenCode supports, with your own API key. Start with the [quickstart](https://ocra.majincheng.com/en/docs/quickstart). The GitHub Action is `jma49/Open-CR-Agent@v0.1.0`.

### What it does

- Reviews uncommitted changes, a branch, a range, a single commit or a GitHub pull request. The [GitHub Action](https://ocra.majincheng.com/en/docs/github) posts inline comments and one summary, and on the next push reviews only what changed.
- Deterministic stages select and bundle the files, pick the reviewers by risk, match rules and anchor every finding to exact lines. The models make the judgment calls: correctness, security, performance, docs and `AGENTS.md` reviewers with read-only tools.
- A verification pass checks each finding against the code, and a judge merges duplicates and drops speculation. The verdict comes from a fixed rubric, and a critical finding the verifier did not confirm cannot block.
- `--ultra` trades cost for recall: every reviewer at every risk tier, two samples each, a plan phase, and the callers of changed symbols.
- It remembers decisions: `ocra memory` records findings a team accepts, and dismissals and replies in pull request threads count on later reviews.
- Everything is a plugin: VCS adapters, agent runtimes, reviewers, rules, tools and event listeners.
- Hardened for pull requests from outside contributors: agents cannot write files, run commands or browse; likely secret files cannot be read; configuration comes from the base branch; text from the change is fenced off in every prompt.

### Cost controls

- `ocra review --plan` shows the files, tasks and prompt sizes of a review without calling a model.
- `--max-cost-usd` (or `maxCostUsd` in `.ocra/config.json`) sets a spend limit for a run. Every run reports tokens and dollars.
- Steps per agent (30), tasks per run (60 by default) and run time are capped. Each model tier takes a failback chain: short rate limits are waited out, and a model out of quota is dropped for the rest of the run.

### Known limitations

- Recall is the weak point: reviewers miss issues a careful human reviewer would find. The [quality page](https://ocra.majincheng.com/en/docs/quality) has the numbers and how they were measured.
- Quality has been measured with Google Gemini models only.
- GitHub is the only pull request platform.
- The verdict is advice, not a security gate: the models read the change, and text in it can steer them.
- Do not install with `--omit=optional`: the OpenCode binary comes as an optional package, and without it `ocra review` stops and asks for `OCRA_OPENCODE_BIN`.
- The JSON report (`--format json`) and `--plan --format json` are versioned (`"version": 1`); later releases only add optional fields, or change the version.
