import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyLabels, labelsFor, readLabels } from "./adjudicate.js";
import { base, expectLogin } from "./golden.fakes.js";
import { parseCase } from "./golden.js";

describe("adjudication", () => {
  it("records labels once, turns valid findings into expectations and keeps typed labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-adjudicate-"));
    await writeFile(join(dir, "clean.json"), JSON.stringify({ ...base, id: "clean", clean: true }));
    const found = (fingerprint: string) => ({
      case: "clean",
      fingerprint,
      category: "security",
      severity: "warning" as const,
      file: "src/login.ts",
      lines: { start: 5, end: 6 },
      title: `title ${fingerprint}`,
      body: "b",
    });
    const labels = labelsFor(dir, [found("0000000000000001"), found("0000000000000002")]);
    const typed = labels.entries[0];
    if (typed) Object.assign(typed, { label: "valid", reason: "Real injection." });
    // Rescoring keeps what was typed.
    const rescored = labelsFor(dir, [found("0000000000000001"), found("0000000000000002")], labels);
    expect(rescored.entries.map((e) => e.label)).toEqual(["valid", null]);

    expect(await applyLabels(rescored, dir)).toEqual({
      applied: 1,
      pending: 1,
      alreadyRecorded: 0,
    });
    expect(await applyLabels(rescored, dir)).toMatchObject({ applied: 0, alreadyRecorded: 1 });
    const saved = parseCase(JSON.parse(await readFile(join(dir, "clean.json"), "utf8")), "clean");
    expect(saved.clean).toBe(false);
    expect(saved.adjudicated).toEqual([
      {
        fingerprint: "0000000000000001",
        label: "valid",
        reason: "Real injection.",
        title: "title 0000000000000001",
      },
    ]);
    expect(saved.expect).toEqual([
      {
        file: "src/login.ts",
        lines: [5, 6],
        category: "security",
        minSeverity: "suggestion",
        concern: "title 0000000000000001",
        also: [],
      },
    ]);
  });

  it("refuses a case id that could name a file outside the directory", async () => {
    const labels = labelsFor("/tmp", []);
    labels.entries.push({
      case: "../../etc/x",
      fingerprint: "0000000000000001",
      category: "correctness",
      severity: "warning",
      file: "a",
      title: "t",
      body: "b",
      label: "invalid",
      reason: "r",
    });
    await expect(applyLabels(labels, "/tmp")).rejects.toThrow('invalid case id "../../etc/x"');
  });
});

describe("adjudication safety", () => {
  const entry = (caseId: string, overrides: Record<string, unknown> = {}) => ({
    case: caseId,
    fingerprint: "0000000000000001",
    category: "correctness",
    severity: "warning" as const,
    file: "src/login.ts",
    lines: { start: 5, end: 6 },
    title: "t",
    body: "b",
    label: "valid" as const,
    reason: "real",
    ...overrides,
  });

  it("refuses a valid finding without lines on a clean case, and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-adjudicate-"));
    const clean = JSON.stringify({ ...base, id: "clean", clean: true });
    await writeFile(join(dir, "clean.json"), clean);
    const labels = { goldenDir: dir, entries: [entry("clean", { lines: undefined })] };
    await expect(applyLabels(labels, dir)).rejects.toThrow("labeled valid on a clean case");
    expect(await readFile(join(dir, "clean.json"), "utf8")).toBe(clean);
  });

  it("writes no case when a later one fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-adjudicate-"));
    const a = JSON.stringify({ ...base, id: "a", expect: [expectLogin] });
    await writeFile(join(dir, "a.json"), a);
    await writeFile(
      join(dir, "b.json"),
      JSON.stringify({ ...base, id: "b", expect: [expectLogin] }),
    );
    const labels = {
      goldenDir: dir,
      entries: [entry("a"), entry("b", { lines: { start: 0, end: 1 } })],
    };
    await expect(applyLabels(labels, dir)).rejects.toThrow("b.json");
    expect(await readFile(join(dir, "a.json"), "utf8")).toBe(a);
  });

  it("names the file when the labels are malformed, and treats only a missing file as none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-labels-"));
    expect(await readLabels(dir)).toBeUndefined();
    await writeFile(join(dir, "adjudication.json"), JSON.stringify({ goldenDir: 1, entries: [] }));
    await expect(readLabels(dir)).rejects.toThrow(/adjudication\.json: goldenDir: /);
    await writeFile(join(dir, "adjudication.json"), "{");
    await expect(readLabels(dir)).rejects.toThrow(/adjudication\.json: not valid JSON/);
  });
});
