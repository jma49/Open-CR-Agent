import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReferenceReach } from "./ceiling.js";
import { goldenImport } from "./commands/golden-import.js";
import { type DatasetRecord, parseRecords } from "./dataset.js";
import { parseCase } from "./golden.js";
import {
  byLanguage,
  type ImportCandidate,
  importCandidates,
  pickInTurn,
  toGoldenCase,
  verdictFor,
} from "./golden-import.js";

function record(pr: number, overrides: Record<string, unknown> = {}) {
  return {
    project_main_language: "Go",
    pr_url: `https://github.com/acme/api/pull/${pr}`,
    pr_source_commit: "a".repeat(40),
    pr_target_commit: `${String(pr).padStart(7, "0")}${"b".repeat(33)}`,
    pr_change_line_count: 120,
    pr_category: "Bug Fix",
    is_ai_comment: false,
    note: "nil map write\n\n  panics when the cache is cold",
    path: "server/handler.go",
    side: "right",
    source_model: "",
    from_line: 10,
    to_line: 12,
    category: "Code Defect",
    context: "File Level",
    label: 1,
    ...overrides,
  };
}

// One pull request per selection rule, plus the ones that pass.
const fixture: DatasetRecord[] = parseRecords([
  record(1),
  record(1, { category: "Maintainability and Readability", from_line: 30 }),
  record(1, { label: 0, from_line: 40 }),
  record(2, { category: "Maintainability and Readability" }),
  record(3, { pr_change_line_count: 900 }),
  record(4, { side: "left" }),
  record(5),
  record(5, { from_line: 20 }),
  record(5, { from_line: 30 }),
  record(5, { from_line: 40 }),
  record(6, { from_line: null, to_line: null }),
  record(7),
  record(8, { project_main_language: "Rust", category: "Security Vulnerability", to_line: null }),
  record(9, { project_main_language: "Rust", category: "Performance" }),
  record(10, { project_main_language: "C", note: "x".repeat(800) }),
]);

const options = { maxChangeLines: 300, exclude: new Set([`0000007${"b".repeat(33)}`]) };

const reachable = (c: ImportCandidate): ReferenceReach[] =>
  c.instance.references.map((r) => ({
    instance: c.instance.id,
    path: r.path,
    category: r.category,
    reach: "reachable",
  }));

describe("importCandidates", () => {
  it("keeps pull requests whose 1-3 in-scope issues sit on the new side", () => {
    const candidates = importCandidates(fixture, options);
    expect(candidates.map((c) => c.instance.prUrl.split("/").pop())).toEqual(["1", "8", "9", "10"]);
    const [first] = candidates;
    expect(first?.issues.map((i) => i.row)).toEqual([0]);
    expect(first?.instance.references).toHaveLength(1);
  });
});

describe("byLanguage and pickInTurn", () => {
  it("takes one acceptable case per language in turn, up to the limit", async () => {
    const queues = byLanguage(importCandidates(fixture, options), 1);
    expect(queues.map((q) => q[0]?.instance.language)).toEqual(["C", "Go", "Rust"]);
    const seen: string[] = [];
    const picked = await pickInTurn(
      queues,
      3,
      async (c) => {
        seen.push(c.instance.id);
        return c.instance.language === "C"
          ? { rejected: "not reachable" }
          : verdictFor(c, reachable(c), "c".repeat(40));
      },
      () => {},
    );
    expect(picked.map((c) => c.language)).toEqual(["Go", "Rust", "Rust"]);
    expect(seen).toHaveLength(4);
  });
});

describe("verdictFor and toGoldenCase", () => {
  const candidates = importCandidates(fixture, options);
  const security = candidates.find((c) => c.instance.prUrl.endsWith("/8"));
  if (!security) throw new Error("fixture lost PR 8");

  it("rejects a pull request with an issue the deterministic stages cannot reach", () => {
    const reaches = reachable(security).map((r) => ({
      ...r,
      reach: "no_domain_reviewer" as const,
    }));
    expect(verdictFor(security, reaches, "c".repeat(40))).toEqual({
      rejected: "not reachable: server/handler.go (no_domain_reviewer)",
    });
  });

  it("writes a valid case that names its rows and says it is unverified", () => {
    const golden = toGoldenCase(security, "c".repeat(40));
    expect(parseCase(JSON.parse(JSON.stringify(golden)), "round trip")).toEqual(golden);
    expect(golden).toMatchObject({
      id: "aacr-api-0000008",
      base: "c".repeat(40),
      head: `0000008${"b".repeat(33)}`,
      tier: "full",
      source: { kind: "aacr" },
      adjudicated: [],
      forbid: [],
      expect: [
        {
          file: "server/handler.go",
          lines: [10, 10],
          category: "security",
          minSeverity: "suggestion",
          concern: "nil map write panics when the cache is cold",
        },
      ],
    });
    expect(golden.source.ref).toContain("rows 12");
    expect(golden.source.ref).toContain("not hand-checked");
    expect(golden.rationale).toMatch(/^Unverified/);
  });

  it("shortens a long comment to a concern", () => {
    const long = candidates.find((c) => c.instance.prUrl.endsWith("/10"));
    if (!long) throw new Error("fixture lost PR 10");
    const concern = toGoldenCase(long, "c".repeat(40)).expect[0]?.concern ?? "";
    expect(concern.length).toBeLessThanOrEqual(502);
    expect(concern.endsWith(" …") || concern.endsWith("…")).toBe(true);
  });
});

describe("ocra-eval golden-import", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-golden-import-"));
    dirs.push(dir);
    return dir;
  };
  const buffer = () => {
    let text = "";
    return { write: (chunk: string) => (text += chunk), text: () => text };
  };
  const deps = {
    records: async () => fixture,
    judge: async (c: ImportCandidate) => verdictFor(c, reachable(c), "c".repeat(40)),
  };

  it("writes the candidates and a summary by language, category and severity", async () => {
    const out = join(tmp(), "candidates");
    const stdout = buffer();
    const argv = ["--from", "aacr", "--limit", "3", "--out", out, "--golden-dir", tmp()];
    expect(await goldenImport(argv, stdout, buffer(), deps)).toBe(0);
    const files = readdirSync(out).filter((f) => f.endsWith(".json"));
    const cases = files.map((f) => parseCase(JSON.parse(readFileSync(join(out, f), "utf8")), f));
    expect(cases.map((c) => c.language).sort()).toEqual(["C", "Go", "Rust"]);
    expect(readdirSync(out)).toContain("summary.md");
    expect(stdout.text()).toContain("| C | 1 |");
    expect(stdout.text()).toContain("| suggestion | 3 |");
  });

  it("skips pull requests already in the golden set", async () => {
    const golden = tmp();
    const existing = toGoldenCase(
      importCandidates(fixture, options)[0] as ImportCandidate,
      "c".repeat(40),
    );
    writeFileSync(join(golden, `${existing.id}.json`), JSON.stringify(existing));
    const out = join(tmp(), "candidates");
    const argv = ["--from", "aacr", "--languages", "go", "--out", out, "--golden-dir", golden];
    await goldenImport(argv, buffer(), buffer(), deps);
    expect(readdirSync(out).sort()).toEqual(["aacr-api-0000007.json", "summary.md"]);
  });

  it("refuses to write over earlier candidates or without a source", async () => {
    const out = tmp();
    writeFileSync(join(out, "old.json"), "{}");
    await expect(
      goldenImport(
        ["--from", "aacr", "--out", out, "--golden-dir", tmp()],
        buffer(),
        buffer(),
        deps,
      ),
    ).rejects.toThrow(/already holds cases/);
    await expect(goldenImport(["--out", tmp()], buffer(), buffer(), deps)).rejects.toThrow(
      /--from aacr/,
    );
  });
});
