import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { goldenImport } from "./commands/golden-import.js";
import { type DatasetRecord, parseRecords } from "./dataset.js";
import { parseCandidate } from "./golden.js";
import { candidateFor, facts, fixture, model, reaches, record } from "./golden-import.fakes.js";
import { type ImportCandidate, toGoldenCase, verdictFor } from "./golden-import.js";

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
const depsFor = (rows: DatasetRecord[]) => ({
  records: async () => rows,
  judge: async (c: ImportCandidate) => verdictFor(c, reaches(c, new Set([70])), facts),
});
const deps = depsFor(fixture);

const run = async (argv: string[], d = deps) => {
  const out = join(tmp(), "candidates");
  const stdout = buffer();
  const code = await goldenImport(
    ["--from", "aacr", "--out", out, "--golden-dir", tmp(), ...argv],
    stdout,
    buffer(),
    d,
  );
  return { code, out, stdout: stdout.text() };
};
const files = (dir: string) =>
  Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((f) => [f, readFileSync(join(dir, f), "utf8")]),
  );

describe("ocra-eval golden-import", () => {
  it("writes the candidates and a summary by language, category and severity", async () => {
    const { code, out, stdout } = await run(["--limit", "3"]);
    expect(code).toBe(0);
    const cases = readdirSync(out)
      .filter((f) => f.endsWith(".json") && f !== "forbid-seeds.json")
      .map((f) => parseCandidate(JSON.parse(readFileSync(join(out, f), "utf8")), f));
    expect(cases.map((c) => c.language).sort()).toEqual(["C", "Go", "Rust"]);
    expect(readdirSync(out)).toContain("summary.md");
    expect(stdout).toContain("| C | 1 | 1 | 0 |");
    expect(stdout).toContain("| suggestion | 3 |");
    expect(stdout).toContain("| MIT | 3 |");
  });

  it("imports pull requests with a person's comment before those with models' only", async () => {
    const rows = parseRecords([
      record(21, { project_main_language: "C", ...model() }),
      record(22, { project_main_language: "Go" }),
      record(23, { project_main_language: "Go" }),
    ]);
    const { out } = await run(["--limit", "2"], depsFor(rows));
    expect(
      readdirSync(out)
        .filter((f) => f.startsWith("aacr-"))
        .sort(),
    ).toEqual(["aacr-api-0000022.json", "aacr-api-0000023.json"]);
    const all = await run([], depsFor(rows));
    expect(all.stdout).toMatch(/\| 3 \| aacr-api-0000021 \| C \| 0 \| 1 \| MIT \|\n$/);
  });

  it("writes the comments labelled incorrect next to the cases, not in them", async () => {
    const { out } = await run([]);
    const seeds = JSON.parse(readFileSync(join(out, "forbid-seeds.json"), "utf8"));
    expect(seeds.seeds).toEqual([
      expect.objectContaining({
        case: "aacr-api-0000001",
        row: 2,
        lines: [40, 41],
        isAiComment: true,
        producer: "GPT-5.2",
      }),
    ]);
    const golden = JSON.parse(readFileSync(join(out, "aacr-api-0000001.json"), "utf8"));
    expect(golden.forbid).toEqual([]);
    expect(golden.rationale).toContain("forbid-seeds.json lists 1 comment(s)");
  });

  it("writes the same bytes twice from the same dataset and seed", async () => {
    const rows = parseRecords([
      ...fixture.map((r) => ({ ...r })),
      record(24, { project_main_language: "Python", from_line: 70 }),
      record(24, { project_main_language: "Python", from_line: 80, ...model() }),
      record(25, { project_main_language: "Python", ...model("Qwen-Coder-480B") }),
    ]);
    const first = await run(["--seed", "7"], depsFor(rows));
    const second = await run(["--seed", "7"], depsFor(rows));
    expect(files(second.out)).toEqual(files(first.out));
    expect(second.stdout).toBe(first.stdout);
    expect(Object.keys(files(first.out))).toContain("forbid-seeds.json");
  });

  it("skips pull requests already in the golden set", async () => {
    const golden = tmp();
    const existing = toGoldenCase(candidateFor(1, fixture), facts);
    writeFileSync(join(golden, `${existing.id}.json`), JSON.stringify(existing));
    const out = join(tmp(), "candidates");
    const argv = ["--from", "aacr", "--languages", "go", "--out", out, "--golden-dir", golden];
    await goldenImport(argv, buffer(), buffer(), deps);
    expect(readdirSync(out).filter((f) => f.startsWith("aacr-"))).toEqual([
      "aacr-api-0000007.json",
    ]);
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
