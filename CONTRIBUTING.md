# Contributing

Thank you for helping. What helps most right now:

- **Bug reports with a reproduction**: the ocra version, the command or workflow, and the smallest change that shows the problem.
- **Review results from real use**: a finding that was wrong, or an issue ocra missed, on code you can share. These become [golden cases](docs/adr/0011-golden-eval-set.md), the measure every quality change is judged by.
- **Platform and integration requests**: which platform, hosted or self-managed, and whether you could test a first version.
- Fixes to the manual, in either language.

Security problems do not go in public issues: see [SECURITY.md](SECURITY.md).

## Before you write code

Open an issue first for anything larger than a small fix, so we can agree on the approach before you spend time on it. The [roadmap](docs/roadmap.md) says what is in scope now. Two things are frozen until there is credit to measure them: prompts, rules and reviewers, and any change marked `[needs-eval]`. Those need an evaluation run before they can merge.

## Setting up

Requires Node.js 22.19 or newer and Git.

```bash
git clone https://github.com/jma49/Open-CR-Agent.git
cd Open-CR-Agent && npm install && npm run build
npm run verify   # Biome, type check and tests; no model or network calls
```

`npm link --workspace @open-cr-agent/cli` puts `ocra` from your checkout on your path. A real review needs a model key; see the [quickstart](docs/manual/en/quickstart.mdx).

## The rules

[AGENTS.md](AGENTS.md) holds the rules for everyone, people and AI agents alike: architecture and package boundaries, security practices, testing, the 500-line limit per file, commit messages and the pull request flow. Read [docs/architecture.md](docs/architecture.md) and [docs/pitfalls.md](docs/pitfalls.md) before changing the runtime, git or evaluation code. The ones contributors most often miss:

- Keep a pull request to one change, and keep `npm run verify` green.
- New behavior ships with a test at the lowest layer that can express it; a fix ships with a test that fails without it.
- Tests never call a model or the network: use the fakes next to the tests.
- A change to user-facing behavior updates the manual in `docs/manual/en` and `docs/manual/zh` in the same pull request. If you cannot write one of the two languages, say so in the pull request and a maintainer will add it.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/); pull requests are merged with a rebase, so each commit lands on `main` as written.

## License

ocra is licensed under [Apache-2.0](LICENSE). By contributing, you agree that your contribution is licensed under the same terms (section 5 of the license). There is no contributor license agreement.

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
