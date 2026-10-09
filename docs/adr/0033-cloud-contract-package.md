# ADR-0033: The wire contract with ocra Cloud lives in one Zod-only package

- Status: accepted (records the decision made on 2026-10-04, #395)
- Date: 2026-10-09

## Context

The CLI and ocra Cloud (ADR-0024) exchange uploads, account settings, memory, device-flow sessions and error codes, and both must redact the same secrets the same way. Each side kept its own copy of those shapes with comments promising the copies stayed equal. They did not: a verdict and tier vocabulary and the `pluginSettings` shape drifted and shipped as bugs. ocra Cloud runs on Cloudflare Workers and lives in a private repository, so it cannot import the engine's packages, which reach Node.js and git.

## Decision

1. **`@open-cr-agent/cloud-contract` holds every shape the CLI and ocra Cloud share, once:** the request and response schemas, the limits, the vocabularies (verdict, risk tier, verification, severity, review source), the provider ids, the error codes and their statuses, the redaction pass with its test vectors, and JSON fixtures of what the CLI sends and reads.
2. **It depends on Zod alone and on nothing of Node.js**, so ocra Cloud runs it as is on Workers. A test in the package enforces both.
3. **It is published and versioned with the other packages**, under the API report and the 0.x rule like any published package (ADR-0034). Neither side retypes a shape it holds; the CLI's tests tie its fixtures to the real upload and parsing code, and its vocabularies to core's.

## Consequences

- A change to the wire is one change to one package, visible in its API report, instead of two hand-synchronized edits in two repositories.
- The package cannot use core's types or helpers; where core and the contract name the same vocabulary, a test keeps them equal rather than an import.
- ocra Cloud must accept every shape a published CLI may still send. Schemas therefore read unknown or invalid optional values as their defaults instead of refusing the upload, so a newer CLI still has its counts kept.
