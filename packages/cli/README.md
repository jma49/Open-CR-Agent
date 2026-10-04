# @open-cr-agent/cli

`ocra` is the command line of [Open-CR-Agent](https://github.com/jma49/Open-CR-Agent), an open-source multi-agent code reviewer for local changes and GitHub pull requests. Deterministic code selects and bundles the files, matches rules and anchors comments; LLM reviewers make the judgment calls, and a verification pass checks what they report.

This is an early 0.x release: options and output may change between minor versions. What the reviews find and miss is measured on the [quality page](https://ocracloud.com/en/docs/quality).

## Install

Requires Node.js 22.19 or newer and Git.

```bash
npm install -g @open-cr-agent/cli
ocra --version
```

## First review

ocra runs its agents on [OpenCode](https://opencode.ai), which is installed with it, using the models you choose for three tiers: `standard` reviews, `light` does helper work, and `top` judges the findings. A comma-separated list is a failback chain. With Google Gemini:

```bash
export GEMINI_API_KEY="your-key"
export OCRA_MODEL_TOP=google/gemini-3.1-pro-preview
export OCRA_MODEL_STANDARD=google/gemini-3.5-flash,google/gemini-flash-lite-latest
export OCRA_MODEL_LIGHT=google/gemini-flash-lite-latest

cd your-repository
ocra review --plan              # what a review would do; calls no model
ocra review                     # uncommitted changes, including untracked files
ocra review --from main         # this branch since it diverged from main
ocra review --max-cost-usd 1    # a spend limit for the run, in dollars
```

Pull requests can also be reviewed by the GitHub Action: inline comments, one summary, and re-reviews of only what changed since the last push.

## Documentation

- [Quickstart](https://ocracloud.com/en/docs/quickstart) and the manual, in [English](https://ocracloud.com/en/docs) and [中文](https://ocracloud.com/zh/docs)
- [GitHub pull requests](https://ocracloud.com/en/docs/github)
- [Changelog](https://github.com/jma49/Open-CR-Agent/blob/main/CHANGELOG.md) and [issues](https://github.com/jma49/Open-CR-Agent/issues)

## License

Apache-2.0
