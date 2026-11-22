import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileEdit } from "@open-cr-agent/core/internal";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { renderPatch } from "./patch.js";

const repos = scratchRepos("ocra-generate-patch-");
afterEach(() => repos.removeAll());

const ORIGINAL = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

function insert(original: string, insertions: { after: number; lines: string[] }[]): FileEdit {
  const lines = original.split("\n");
  for (const { after, lines: block } of [...insertions].sort((a, b) => b.after - a.after)) {
    lines.splice(after, 0, ...block);
  }
  return { kind: "insert", path: "src/a.ts", original, insertions, content: lines.join("\n") };
}

// The diff is what `git apply` takes, and applying it gives the edits' content.
function applied(original: string, edits: FileEdit[]): Record<string, string> {
  const repo = repos.create();
  repo.commit("base", { "src/a.ts": original });
  const patch = join(repo.dir, ".git", "ocra.patch");
  writeFileSync(patch, renderPatch(edits));
  repo.git("apply", "--whitespace=nowarn", patch);
  return Object.fromEntries(
    edits.map((e) => [e.path, readFileSync(join(repo.dir, e.path), "utf8")]),
  );
}

describe("renderPatch", () => {
  it("renders insertions near and far apart, which git applies to the content", () => {
    const edit = insert(`${ORIGINAL}\n`, [
      { after: 0, lines: ["/** first */"] },
      { after: 4, lines: ["/**", " * fifth", " */"] },
      { after: 15, lines: ["/** sixteenth */"] },
    ]);
    expect(renderPatch([edit]).match(/^@@ /gm)).toHaveLength(2);
    expect(applied(`${ORIGINAL}\n`, [edit])).toEqual({ "src/a.ts": edit.content });
  });

  it("keeps a file without a newline at its end as it is", () => {
    const edit = insert(ORIGINAL, [{ after: 18, lines: ["/** last but one */"] }]);
    expect(renderPatch([edit])).toContain("\\ No newline at end of file");
    expect(applied(ORIGINAL, [edit])).toEqual({ "src/a.ts": edit.content });
  });

  it("renders a new file beside an edited one", () => {
    const created: FileEdit = { kind: "create", path: "src/a.test.ts", content: "it();\n" };
    const edit = insert(`${ORIGINAL}\n`, [{ after: 2, lines: ["// third"] }]);
    expect(applied(`${ORIGINAL}\n`, [edit, created])).toEqual({
      "src/a.ts": edit.content,
      "src/a.test.ts": "it();\n",
    });
  });
});
