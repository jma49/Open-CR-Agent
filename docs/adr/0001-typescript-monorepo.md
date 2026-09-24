# ADR-0001: TypeScript monorepo

- Status: accepted
- Date: 2026-09-24

## Context

The chosen agent runtime (OpenCode) and its SDK are TypeScript. Mixing Go and TypeScript would need a hand-built IPC layer (subprocess JSONL, gRPC, or WASM/N-API). Review latency is dominated by LLM calls, not CPU; the CPU-heavy part, code search, is delegated to native binaries (`git grep`, ripgrep).

## Decision

Write everything in TypeScript (strict, ESM, Node >= 22) as an npm-workspaces monorepo. Use Vitest for tests and Biome for lint and format.

## Consequences

- One language and toolchain, no IPC layer to maintain.
- Plugins are plain npm packages.
- Distribution needs Node; a single-binary build can be revisited later.
