import type { FileDiff, Learning } from "@open-cr-agent/core";
import type { LearningDraft, LearningEvidence } from "@open-cr-agent/core/internal";
import { describe, expect, it } from "vitest";
import { type Candidate, type LearnOptions, learnFrom } from "./pipeline.js";

function diff(path: string): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    kind: "modified",
    isBinary: false,
    additions: 1,
    deletions: 1,
    hunks: [],
    patch: "+  conn.release();",
  };
}

function candidate(ref: string, path = "src/db/query.ts"): Candidate {
  return {
    ref,
    evidence: async (): Promise<LearningEvidence> => ({
      source: { kind: "fix-commit", ref },
      subject: `fix: ${ref}`,
      message: "",
      files: [diff(path)],
    }),
  };
}

function lesson(evidence: LearningEvidence, fields: Partial<LearningDraft> = {}): LearningDraft {
  return {
    source: evidence.source,
    title: `Lesson from ${evidence.source.ref}`,
    body: "Body.",
    paths: [`${evidence.files[0]?.newPath.split("/").slice(0, -1).join("/")}/**`],
    symbols: [],
    keywords: [],
    ...fields,
  };
}

const existing: Learning = {
  id: "release-pooled",
  title: "Release pooled connections",
  body: "Body.",
  paths: ["src/db/**"],
  symbols: [],
  keywords: [],
  critical: false,
  source: { kind: "fix-commit", ref: "a1b2c3d" },
};

function options(fields: Partial<LearnOptions> = {}): LearnOptions & { drafted: string[] } {
  const drafted: string[] = [];
  return {
    drafted,
    existing: [],
    max: 20,
    concurrency: 1,
    draft: async (evidence) => {
      drafted.push(evidence.source.ref ?? "");
      return lesson(evidence);
    },
    mayCall: () => true,
    signal: new AbortController().signal,
    warn: () => {},
    ...fields,
  };
}

describe("learnFrom", () => {
  it("keeps one learning per candidate that holds a lesson, in the candidates' order", async () => {
    const o = options();
    const result = await learnFrom([candidate("f1", "src/a/x.ts"), candidate("f2", "lib/y.ts")], o);
    expect(result.kept.map((k) => k.source.ref)).toEqual(["f1", "f2"]);
    expect(result).toMatchObject({ drafted: 2, recorded: 0, duplicates: 0 });
  });

  it("never drafts a candidate an existing learning records, by full or short name", async () => {
    const o = options({ existing: [existing] });
    const full = `a1b2c3d${"0".repeat(33)}`;
    const result = await learnFrom([candidate(full), candidate("f2", "lib/y.ts")], o);
    expect(o.drafted).toEqual(["f2"]);
    expect(result.recorded).toBe(1);
  });

  it("drafts at most max candidates, newest first", async () => {
    const o = options({ max: 1 });
    await learnFrom([candidate("f1"), candidate("f2")], o);
    expect(o.drafted).toEqual(["f1"]);
  });

  it("drops a draft that repeats a learning on the same paths, and a repeat within the run", async () => {
    const o = options({
      existing: [existing],
      draft: async (evidence) =>
        lesson(evidence, {
          title:
            evidence.source.ref === "f1"
              ? "Release the pooled connections"
              : "Never log request bodies",
          paths: evidence.source.ref === "f1" ? ["src/db/**"] : ["src/http/**"],
        }),
    });
    const result = await learnFrom(
      [candidate("f1"), candidate("f2", "src/http/a.ts"), candidate("f3", "src/http/b.ts")],
      o,
    );
    expect(result.kept.map((k) => k.source.ref)).toEqual(["f2"]);
    expect(result.duplicates).toBe(2);
  });

  it("drops a draft the selection would not give to the change it came from", async () => {
    const o = options({ draft: async (evidence) => lesson(evidence, { paths: ["elsewhere/**"] }) });
    const result = await learnFrom([candidate("f1")], o);
    expect(result).toMatchObject({ kept: [], unselected: 1 });
  });

  it("stops drafting at the spend limit and counts what it left", async () => {
    let calls = 0;
    const o = options({ mayCall: () => calls++ < 1 });
    const result = await learnFrom(
      [candidate("f1", "a/x.ts"), candidate("f2", "b/x.ts"), candidate("f3", "c/x.ts")],
      { ...o, draft: o.draft },
    );
    expect(result.kept).toHaveLength(1);
    expect(result.unaffordable).toBe(2);
  });

  it("records a failed draft as a warning and goes on", async () => {
    const warnings: string[] = [];
    const o = options({
      warn: (w) => warnings.push(w),
      draft: async (evidence) => {
        if (evidence.source.ref === "f1") throw new Error("model down");
        return lesson(evidence);
      },
    });
    const result = await learnFrom([candidate("f1", "a/x.ts"), candidate("f2", "b/x.ts")], o);
    expect(result).toMatchObject({ failed: 1, drafted: 1 });
    expect(warnings).toEqual(["f1 could not be drafted: model down"]);
  });

  it("counts a candidate without a lesson as declined", async () => {
    const result = await learnFrom([candidate("f1")], options({ draft: async () => undefined }));
    expect(result).toMatchObject({ kept: [], declined: 1, drafted: 0 });
  });
});
