import { describe, expect, it } from "vitest";
import upload from "../fixtures/upload.json" with { type: "json" };
import {
  MAX_EVIDENCE,
  MAX_EVIDENCE_FIELD,
  MAX_FIELD,
  MAX_FINDINGS,
  MAX_RULE_TEXT,
} from "./limits.js";
import { reviewUploadSchema, sharedFindingSchema, uploadAnswerSchema } from "./upload.js";

const { about: _, ...body } = upload;

describe("the review upload", () => {
  it("reads a walkthrough that does not fit as absent, and keeps the rest", () => {
    const groups = Array.from({ length: 13 }, () => ({ title: "t", files: ["a.ts"], note: "" }));
    const parsed = reviewUploadSchema.parse({ ...body, walkthrough: { overview: "o", groups } });
    expect(parsed.walkthrough).toBeUndefined();
    expect(parsed.runId).toBe(body.runId);
  });

  it("reads a linked task that does not fit as null, and too many as absent", () => {
    const task = { tracker: "github", key: "#1", state: "open" };
    const parsed = reviewUploadSchema.parse({
      ...body,
      linkedTasks: [task, { ...task, key: "#1 <script>" }],
    });
    expect(parsed.linkedTasks).toEqual([task, null]);
    const many = reviewUploadSchema.parse({ ...body, linkedTasks: [task, task, task, task] });
    expect(many.linkedTasks).toBeUndefined();
    expect(many.runId).toBe(body.runId);
  });

  it("reads a learning id or a check that does not fit as null, and too many as absent", () => {
    const check = { id: "chk_1.2", outcome: "failed", reason: "no migration note" };
    const parsed = reviewUploadSchema.parse({
      ...body,
      learnings: ["retry-budget", "../etc"],
      mergeChecks: [check, { id: "chk_2", outcome: "skipped" }],
    });
    expect(parsed.learnings).toEqual(["retry-budget", null]);
    expect(parsed.mergeChecks).toEqual([check, null]);
    const many = reviewUploadSchema.parse({
      ...body,
      mergeChecks: Array.from({ length: 21 }, () => check),
    });
    expect(many.mergeChecks).toBeUndefined();
    expect(many.runId).toBe(body.runId);
  });

  it("keeps every field of the CLI's real upload", () => {
    expect(reviewUploadSchema.parse(body)).toEqual(body);
  });

  it("refuses an upload that does not say which run, repository and source it is", () => {
    for (const key of ["runId", "repoHash", "source"] as const) {
      expect(reviewUploadSchema.safeParse({ ...body, [key]: "not one" }).success, key).toBe(false);
      const { [key]: _gone, ...without } = body;
      expect(reviewUploadSchema.safeParse(without).success, key).toBe(false);
    }
  });

  it("keeps the counts when a newer client sends a value it does not know", () => {
    const parsed = reviewUploadSchema.parse({
      ...body,
      tier: "enormous",
      verdict: "maybe",
      complete: "yes",
      findings: { critical: -1, warning: 1.5, suggestion: 2 },
      files: "many",
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 1e9 },
      ocraVersion: "a version with spaces",
    });
    expect(parsed).toMatchObject({
      tier: null,
      verdict: null,
      complete: true,
      findings: { critical: 0, warning: 0, suggestion: 2 },
      files: { reviewed: 0, notReviewed: 0 },
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0 },
      ocraVersion: null,
    });
  });

  it("reads a reviewer's counts or a finding that does not fit as null, and the rest alike", () => {
    const parsed = reviewUploadSchema.parse({
      ...body,
      reviewers: { ...body.reviewers, broken: "not counts" },
      findingList: [...body.findingList, { fingerprint: "x" }],
    });
    expect(parsed.reviewers?.broken).toBeNull();
    expect(parsed.findingList?.at(-1)).toBeNull();
    expect(parsed.findingList?.slice(0, -1)).toEqual(body.findingList);
  });

  it("reads an outcome fingerprint that does not fit as null, and too many as absent", () => {
    const parsed = reviewUploadSchema.parse({
      ...body,
      outcomes: { fixed: 1, dismissed: 0, fixedFingerprints: ["aaaabbbbccccdddd", "a b"] },
    });
    expect(parsed.outcomes).toEqual({
      fixed: 1,
      dismissed: 0,
      fixedFingerprints: ["aaaabbbbccccdddd", null],
    });
    const many = reviewUploadSchema.parse({
      ...body,
      outcomes: { fixed: 201, dismissed: 0, dismissedFingerprints: Array(201).fill("aaaabbbb") },
    });
    expect(many.outcomes).toEqual({ fixed: 201, dismissed: 0 });
  });

  it("drops a pull request it cannot name, and keeps the counts", () => {
    for (const pullRequest of [
      { ...body.pullRequest, repository: "git@github.com:octo/app" },
      { ...body.pullRequest, number: 0 },
      { ...body.pullRequest, headSha: "HEAD" },
      "octo/app#42",
    ]) {
      const parsed = reviewUploadSchema.parse({ ...body, pullRequest });
      expect(parsed.pullRequest, JSON.stringify(pullRequest)).toBeUndefined();
      expect(parsed.findings).toEqual(body.findings);
    }
  });

  it("is an upload of counts alone without the ADR-0028 and ADR-0038 parts", () => {
    const {
      reviewers: _r,
      verification: _v,
      outcomes: _o,
      findingList: _f,
      pullRequest: _p,
      ...counts
    } = body;
    expect(reviewUploadSchema.parse(counts)).toEqual(counts);
  });
});

describe("a shared finding", () => {
  const [finding] = body.findingList;

  it("needs its identity, severity, file, title and body", () => {
    for (const key of ["fingerprint", "reviewer", "severity", "file", "title", "body"] as const) {
      const { [key]: _gone, ...without } = finding ?? {};
      expect(sharedFindingSchema.safeParse(without).success, key).toBe(false);
    }
  });

  it("reads the optional parts it cannot use as absent", () => {
    expect(
      sharedFindingSchema.parse({
        ...finding,
        category: 3,
        verification: "sure",
        lineStart: -1,
        suggestion: {},
        redacted: "yes",
      }),
    ).toMatchObject({
      category: null,
      verification: null,
      lineStart: null,
      suggestion: null,
      redacted: undefined,
    });
  });

  it("holds each text field to MAX_FIELD: a longer title or body is refused, the rest read as absent", () => {
    const long = "x".repeat(MAX_FIELD + 1);
    expect(
      sharedFindingSchema.safeParse({ ...finding, title: "x".repeat(MAX_FIELD) }).success,
    ).toBe(true);
    for (const key of ["title", "body"] as const)
      expect(sharedFindingSchema.safeParse({ ...finding, [key]: long }).success, key).toBe(false);
    expect(
      sharedFindingSchema.parse({ ...finding, category: long, suggestion: long, code: long }),
    ).toMatchObject({ category: null, suggestion: null, code: null });
  });
});

describe("a shared finding's fix", () => {
  const [finding] = body.findingList;
  const fix = { startLine: 3, endLine: 4, replacement: "return a + b;" };

  it("is kept as sent", () => {
    expect(sharedFindingSchema.parse({ ...finding, fix }).fix).toEqual(fix);
    expect(sharedFindingSchema.parse({ ...finding, fix: { ...fix, replacement: "" } }).fix).toEqual(
      { ...fix, replacement: "" },
    );
  });

  it("reads as absent when its lines are backwards, not lines, or its code is too long", () => {
    for (const bad of [
      { ...fix, endLine: 2 },
      { ...fix, startLine: 0 },
      { ...fix, startLine: 1.5 },
      { ...fix, replacement: "x".repeat(MAX_FIELD + 1) },
      { startLine: 3, endLine: 4 },
      "return a + b;",
    ]) {
      const parsed = sharedFindingSchema.parse({ ...finding, fix: bad });
      expect(parsed.fix, JSON.stringify(bad).slice(0, 60)).toBeUndefined();
    }
  });
});

describe("the upload's answer", () => {
  it("is read leniently: a count it cannot use is none", () => {
    expect(uploadAnswerSchema.parse({ id: "r", findings: 3 })).toEqual({ id: "r", findings: 3 });
    expect(uploadAnswerSchema.parse({ findings: "3", dropped: [] })).toEqual({
      findings: undefined,
      dropped: undefined,
    });
  });
});

describe("a shared finding's evidence", () => {
  const [finding] = body.findingList;

  it("is kept as sent, and absent from an older upload", () => {
    const evidence = ["`id` comes from `req.params`", "no caller escapes it"];
    expect(sharedFindingSchema.parse({ ...finding, evidence }).evidence).toEqual(evidence);
    expect(sharedFindingSchema.parse(body.findingList[1])).not.toHaveProperty("evidence");
  });

  it("reads as absent with too many entries, one too long, or not a list", () => {
    for (const bad of [
      Array(MAX_EVIDENCE + 1).fill("a fact"),
      ["x".repeat(MAX_EVIDENCE_FIELD + 1)],
      ["a fact", 3],
      "a fact",
    ]) {
      const parsed = sharedFindingSchema.parse({ ...finding, evidence: bad });
      expect(parsed.evidence, JSON.stringify(bad).slice(0, 60)).toBeUndefined();
      expect(parsed.title).toBe(finding?.title);
    }
  });
});

describe("a shared finding's rule", () => {
  const [finding] = body.findingList;

  it("is kept as sent, and absent from an older upload", () => {
    const rule = { kind: "learning", id: "retry-without-backoff" };
    expect(sharedFindingSchema.parse({ ...finding, rule }).rule).toEqual(rule);
    const { rule: _r, ...older } = finding ?? {};
    expect(sharedFindingSchema.parse(older)).not.toHaveProperty("rule");
  });

  it("reads as absent with an unknown kind or an id that is not one", () => {
    for (const bad of [
      { kind: "guideline", id: "tenant" },
      { kind: "rule", id: "Tenant Ids" },
      { kind: "rule", id: "x".repeat(81) },
      "tenant",
    ]) {
      const parsed = sharedFindingSchema.parse({ ...finding, rule: bad });
      expect(parsed.rule, JSON.stringify(bad)).toBeUndefined();
      expect(parsed.title).toBe(finding?.title);
    }
  });
});

describe("the rules' text in an upload", () => {
  it("is kept by id, and absent from an older upload", () => {
    const provenance = { rules: { "tenant-scope": "Scope queries by tenant." } };
    expect(reviewUploadSchema.parse({ ...body, provenance }).provenance).toEqual(provenance);
    const { provenance: _p, ...older } = body;
    expect(reviewUploadSchema.parse(older)).not.toHaveProperty("provenance");
  });

  it("reads as absent with an id that is not one, a text too long or too many rules", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => [`rule-${i}`, "r"]),
    );
    for (const rules of [
      { "Tenant Scope": "r" },
      { "tenant-scope": "x".repeat(MAX_RULE_TEXT + 1) },
      { "tenant-scope": 1 },
      many,
    ]) {
      const parsed = reviewUploadSchema.parse({ ...body, provenance: { rules } });
      expect(parsed.provenance, JSON.stringify(rules).slice(0, 60)).toBeUndefined();
      expect(parsed.runId).toBe(body.runId);
    }
  });
});

describe("a repository's name in an upload", () => {
  const repo = { name: "octo/app", url: "https://github.com/octo/app" };

  it("is kept as sent, with or without its address, and absent from an older upload", () => {
    expect(reviewUploadSchema.parse({ ...body, repo }).repo).toEqual(repo);
    const nested = { name: "group/sub/app" };
    expect(reviewUploadSchema.parse({ ...body, repo: nested }).repo).toEqual(nested);
    const { repo: _r, ...older } = { ...body, repo };
    expect(reviewUploadSchema.parse(older)).not.toHaveProperty("repo");
  });

  it("reads as absent with a name that is not a path on a host", () => {
    for (const name of [
      "app",
      "octo/",
      "/octo/app",
      "octo/../app",
      "octo/a pp",
      `o/${"a".repeat(200)}`,
    ]) {
      const parsed = reviewUploadSchema.parse({ ...body, repo: { ...repo, name } });
      expect(parsed.repo, name).toBeUndefined();
      expect(parsed.runId).toBe(body.runId);
    }
  });

  it("keeps the name without an address that is not the normalised https one", () => {
    for (const url of [
      "http://github.com/octo/app",
      "https://user:pass@github.com/octo/app",
      "https://github.com:8443/octo/app",
      "https://GitHub.com/Octo/App",
      "https://github.com/octo/app.git",
      "git@github.com:octo/app",
    ]) {
      expect(reviewUploadSchema.parse({ ...body, repo: { ...repo, url } }).repo, url).toEqual({
        name: "octo/app",
      });
    }
  });
});
