# @open-cr-agent/cloud-contract

The wire contract between [Open-CR-Agent](https://github.com/jma49/Open-CR-Agent), the multi-agent code reviewer, and ocra Cloud: Zod schemas (review upload, account preferences and memory, device sign-in), upload limits, shared vocabularies (verdicts, tiers, efforts, provider ids), error codes, and the redaction pass with its test vectors (`fixtures/redaction-vectors.json`). Both sides import it, so a shape cannot change on one side only. It depends only on Zod and runs on Node.js and Cloudflare Workers.

Most users want [`@open-cr-agent/cli`](https://www.npmjs.com/package/@open-cr-agent/cli) (the `ocra` command) and the [manual](https://ocracloud.com). All packages share one version. Apache-2.0.
