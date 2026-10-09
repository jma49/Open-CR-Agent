import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { latestRelease } from "./lib/changelog.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
/** @param {string} path */
const read = (path) => readFileSync(join(root, path), "utf8");

// The roadmap's opening paragraph says which release it describes, and went
// stale twice after a release (#377, #514). The release pull request
// (npm run version-packages) fails here until someone brings the header, and
// the milestones under it, up to the new release.
describe("docs/roadmap.md", () => {
  const roadmap = read("docs/roadmap.md");
  const intro = roadmap.slice(0, roadmap.indexOf("\n## "));
  const header = /as of (\d{4}-\d{2}-\d{2}) \(([^\s)]+) released\)/.exec(intro);
  const release = latestRelease(read("CHANGELOG.md"));

  it('says in its opening paragraph "as of <date> (<version> released)"', () => {
    expect(header, intro).not.toBeNull();
    expect(release).toBeDefined();
  });

  it(`names the latest release in CHANGELOG.md, ${release?.version}`, () => {
    expect(header?.[2]).toBe(release?.version);
  });

  it(`is dated no earlier than that release, ${release?.date}`, () => {
    const asOf = header?.[1] ?? "";
    expect(asOf >= (release?.date ?? "∞"), `as of ${asOf}`).toBe(true);
  });
});
