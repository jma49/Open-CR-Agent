# ADR-0002: VCS adapter abstraction, GitHub first

- Status: accepted
- Date: 2026-09-24

## Context

Cloudflare runs on GitLab and OpenCodeReview supports several CI systems. We want the pipeline independent of any hosting platform, but only have capacity to build one integration first.

## Decision

Define a `VcsAdapter` contract in `core` (load change request and diff, load the previous review, publish results). Implement `vcs-github` first. The local working tree is also an adapter, so CLI and CI share one pipeline.

## Consequences

- GitLab, Gerrit or Bitbucket can be added as separate packages.
- The contract must stay platform-neutral: thread and verdict concepts are mapped by each adapter.
