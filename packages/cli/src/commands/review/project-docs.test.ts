import { describe, expect, it } from "vitest";
import { loadProjectDocs, PROJECT_DOC_FILE_LIMITS } from "./project-docs.js";
import type { TrustedTree } from "./target.js";

function tree(files: Record<string, string>): TrustedTree {
  return {
    readFile: async (path) => files[path],
    listFiles: async (dir) =>
      Object.keys(files).filter(
        (p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"),
      ),
  };
}

async function load(entries: string[], files: Record<string, string>) {
  const warnings: string[] = [];
  const docs = await loadProjectDocs(entries, tree(files), (w) => warnings.push(w));
  return { paths: docs.map((d) => d.path), warnings };
}

describe("loadProjectDocs", () => {
  it("reads a named file and a directory's Markdown files, each once", async () => {
    const { paths, warnings } = await load(["docs/design/", "docs/arch.md", "docs/design/b.md"], {
      "docs/arch.md": "# A",
      "docs/design/b.md": "# B",
      "docs/design/a.mdx": "# A",
      "docs/design/notes.txt": "no",
      "docs/design/deep/c.md": "# C",
    });
    expect(paths).toEqual(["docs/design/a.mdx", "docs/design/b.md", "docs/arch.md"]);
    expect(warnings).toEqual([]);
  });

  it("warns about a path outside the repository after normalising it, and a missing file", async () => {
    const { paths, warnings } = await load(["docs/../../secret.md", "docs/gone.md"], {
      "../secret.md": "x",
    });
    expect(paths).toEqual([]);
    expect(warnings).toEqual([
      "projectDocs: docs/../../secret.md is outside the repository",
      "projectDocs: docs/gone.md is not in the trusted revision",
    ]);
  });

  it("skips a document over the size limit and reads no more than the file limit", async () => {
    const files = Object.fromEntries(
      Array.from({ length: PROJECT_DOC_FILE_LIMITS.files + 1 }, (_, i) => [
        `d/${String(i).padStart(3, "0")}.md`,
        "x",
      ]),
    );
    files["d/000.md"] = "x".repeat(PROJECT_DOC_FILE_LIMITS.bytes + 1);
    const { paths, warnings } = await load(["d"], files);
    expect(paths).toHaveLength(PROJECT_DOC_FILE_LIMITS.files - 1);
    expect(warnings).toHaveLength(2);
  });
});
