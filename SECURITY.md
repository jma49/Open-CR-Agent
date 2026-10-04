# Security policy

ocra reviews code that may be hostile, so its security model is part of the product: the manual's [Security and privacy](docs/manual/en/security.mdx) and [Threat model](docs/manual/en/threat-model.mdx) pages say what it promises. A way around one of those promises is a vulnerability.

## Reporting a vulnerability

Report it privately, through GitHub: [Security → Report a vulnerability](https://github.com/jma49/Open-CR-Agent/security/advisories/new). Only the maintainers and you can see the report. If you cannot use GitHub, email [meetjincheng@yahoo.com](mailto:meetjincheng@yahoo.com) with "ocra security" in the subject. Do not open a public issue or pull request for it.

Please include:

- the ocra version (`ocra --version`) and how you ran it (CLI, GitHub Action, flags, model provider);
- the smallest change, repository or input that reproduces it;
- what an attacker gains.

## What happens next

ocra has one maintainer, so these are commitments of intent, not a staffed service:

- an acknowledgement within 7 days;
- an assessment, and a fix in a patch release of the latest version when the report holds;
- a GitHub security advisory and a CHANGELOG entry once the fix is published, crediting you unless you prefer otherwise;
- public disclosure within 90 days of the report, earlier once a fix is out, or later only if we agree on it.

## Supported versions

Only the latest release gets fixes; ocra is an early 0.x release and does not backport. Upgrade to the newest version to get a fix.

## Scope

In scope, with examples:

- **Isolation.** An agent reading outside the repository, a secret file (`.env`, keys, credentials) or `.git/`, including through symbolic links or renames.
- **Running untrusted code.** A reviewed change (its code, text, configuration or comments) that makes ocra run code, load a plugin or an OpenCode setting, write files, or reach the network beyond the model provider, in pull request mode or under `--no-repo-config`.
- **Secrets.** A provider key or platform token reaching a prompt, log, report, session file or comment.
- **Output.** Text from a reviewed change or a model that ocra publishes as markup, a mention, an image, a link or an ocra command (`/ocra …`), or prints to a terminal with control sequences intact.
- **Authority.** A command, dismissal or override that counts without the permission the manual requires, or an edited summary state that ocra trusts.
- **Supply chain.** The GitHub Action or the release process installing code other than what this repository published.

Out of scope:

- A model missing a real issue or reporting a wrong one. Report it as a regular issue: it helps the golden set.
- Prompt injection that changes findings or the verdict. The verdict is documented as advice, not a security gate, and the adversarial tier measures this. It becomes a vulnerability when it gets past a defense in code, for example when a confirmed critical finding is dropped, or model text forms a command.
- Vulnerabilities in model providers, OpenCode, GitHub or npm themselves. Report them there, and tell us if ocra should mitigate them.
- Harm from plugins or configuration you chose to trust: plugins run code by design.
- Cost when you control the configuration: the spend limit is yours to set.
