import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bumpPins, manualPages, pinsIn } from "./manual-pins.mjs";
import { lockstep, readWorkspaces } from "./release-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const PAGE = `\`\`\`bash
npm install -g --ignore-scripts @open-cr-agent/cli@0.5.0
docker run ghcr.io/jma49/ocra:0.5.0 ocra review
docker pull ghcr.io/jma49/ocra:0.5.0@sha256:<digest>
\`\`\`

Since 0.2.0, images run as \`node\`. Use \`ghcr.io/jma49/ocra:<version>\` or \`@open-cr-agent/core\`.
- uses: jma49/Open-CR-Agent@d3af4e2189007de77dcf17e736855d04be4a491c # v0.5.0
`;

describe("bumpPins", () => {
  it("moves every package and image pin to the new version and nothing else", () => {
    const next = bumpPins(PAGE, "0.6.0");
    expect(next).toBe(
      PAGE.replace("cli@0.5.0", "cli@0.6.0").replaceAll("ocra:0.5.0", "ocra:0.6.0"),
    );
    expect(pinsIn(next).map((p) => p.version)).toEqual(["0.6.0", "0.6.0", "0.6.0"]);
    expect(next).toContain("Since 0.2.0");
    expect(next).toContain("# v0.5.0");
  });

  it("leaves the manual on the last stable release for a prerelease", () => {
    expect(bumpPins(PAGE, "0.6.0-rc.1")).toBe(PAGE);
  });
});

describe("version pins in the manual", () => {
  const { version } = lockstep(readWorkspaces(root));
  const found = manualPages(root).flatMap((path) =>
    pinsIn(readFileSync(path, "utf8")).map((p) => ({
      ...p,
      where: `${relative(root, path)}:${p.line}`,
    })),
  );

  it("are found in both languages", () => {
    expect(found.some((p) => p.where.startsWith("docs/manual/en/"))).toBe(true);
    expect(found.some((p) => p.where.startsWith("docs/manual/zh/"))).toBe(true);
  });

  it.skipIf(version.includes("-"))(`all name the packages' version, ${version}`, () => {
    const stale = found.filter((p) => p.version !== version).map((p) => `${p.where} ${p.pin}`);
    expect(stale).toEqual([]);
  });
});
