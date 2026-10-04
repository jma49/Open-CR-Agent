# @open-cr-agent/cloud-contract

The wire contract between [Open-CR-Agent](https://github.com/jma49/Open-CR-Agent), the multi-agent code reviewer, and ocra Cloud: Zod schemas for the review upload, the account's preferences and memory and the device sign-in, the upload limits, the shared vocabularies (verdicts, tiers, efforts, provider ids), the error codes, and the redaction pass with its test vectors (`fixtures/redaction-vectors.json`). Both sides import it, so a shape cannot change on one side only. It depends on Zod alone and runs on Node.js and Cloudflare Workers.

Most users want [`@open-cr-agent/cli`](https://www.npmjs.com/package/@open-cr-agent/cli), which provides the `ocra` command and installs this package; see the [manual](https://ocracloud.com). All `@open-cr-agent` packages are released together at one version. Apache-2.0.
