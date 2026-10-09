# @open-cr-agent/cli

`ocra` is the command line of [Open-CR-Agent](https://github.com/jma49/Open-CR-Agent), open-source AI code review built for pull requests you do not trust. It reviews local changes, GitHub pull requests and GitLab merge requests with your own model key; a verifier and a judge check every finding before it is posted, and comments are anchored by the code they quote.

Early 0.x: options and output may change between minor versions. What reviews find and miss is on the [quality page](https://ocracloud.com/en/docs/quality).

## Install

Requires Node.js 22.19 or newer and Git.

```bash
npm install -g @open-cr-agent/cli
ocra --version
```

## First review

ocra runs its agents on [OpenCode](https://opencode.ai), installed with it, with the models you choose for three tiers: `standard` reviews, `light` helps, `top` judges. A comma-separated list is a failback chain. With Google Gemini:

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

The GitHub Action reviews pull requests: inline comments, one summary, and re-reviews of only what changed since the last push.

## Documentation

- [Quickstart](https://ocracloud.com/en/docs/quickstart) and the manual, in [English](https://ocracloud.com/en/docs) and [中文](https://ocracloud.com/zh/docs)
- [GitHub pull requests](https://ocracloud.com/en/docs/github) and [GitLab merge requests](https://ocracloud.com/en/docs/gitlab)
- [Changelog](https://github.com/jma49/Open-CR-Agent/blob/main/CHANGELOG.md) and [issues](https://github.com/jma49/Open-CR-Agent/issues)

## License

Apache-2.0
