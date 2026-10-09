import { describe, expect, it } from "vitest";
import upload from "../fixtures/upload.json" with { type: "json" };
import { MAX_FIELD } from "./limits.js";
import { reviewUploadSchema, sharedFindingSchema, uploadAnswerSchema } from "./upload.js";

const { about: _, ...body } = upload;

describe("the review upload", () => {
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

  it("is an upload of counts alone without the ADR-0028 parts", () => {
    const { reviewers: _r, verification: _v, outcomes: _o, findingList: _f, ...counts } = body;
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

describe("the upload's answer", () => {
  it("is read leniently: a count it cannot use is none", () => {
    expect(uploadAnswerSchema.parse({ id: "r", findings: 3 })).toEqual({ id: "r", findings: 3 });
    expect(uploadAnswerSchema.parse({ findings: "3", dropped: [] })).toEqual({
      findings: undefined,
      dropped: undefined,
    });
  });
});
