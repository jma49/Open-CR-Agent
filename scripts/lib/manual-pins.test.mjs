import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTION_TEMPLATE,
  actionPinFiles,
  actionPinsIn,
  bumpActionPins,
  bumpPins,
  manualPages,
  pinsIn,
  recipeFiles,
  unpinnedUses,
} from "./manual-pins.mjs";
import { lockstep, readWorkspaces } from "./release.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

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
  const version = /** @type {string} */ (lockstep(readWorkspaces(root)).version);
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

const OLD = "d3af4e2189007de77dcf17e736855d04be4a491c";
const NEW = "82a3f1183a3177e9efa401d87eb95dea495ef619";

describe("bumpActionPins", () => {
  it("moves every Action pin and its version comment, and keeps a placeholder a placeholder", () => {
    const text = `- uses: jma49/Open-CR-Agent@${OLD} # v0.5.0
- uses: jma49/Open-CR-Agent@<commit> # v0.5.0
- uses: actions/checkout@v7 # v0.5.0
"jma49/Open-CR-Agent@${OLD} # v0.5.0";
`;
    expect(bumpActionPins(text, NEW, "0.6.0")).toBe(
      text.replaceAll(OLD, NEW).replace(/(Open-CR-Agent@\S+) # v0\.5\.0/g, "$1 # v0.6.0"),
    );
    expect(actionPinsIn(bumpActionPins(text, NEW, "0.6.0"))).toEqual([
      { commit: NEW, version: "0.6.0", line: 1 },
      { commit: "<commit>", version: "0.6.0", line: 2 },
      { commit: NEW, version: "0.6.0", line: 4 },
    ]);
  });

  it("refuses what is not a full commit id or a version", () => {
    expect(() => bumpActionPins("", "82a3f11", "0.6.0")).toThrow(/full commit/);
    expect(() => bumpActionPins("", NEW, "v0.6.0")).toThrow(/version/);
  });
});

describe("the Action's pin", () => {
  const found = actionPinFiles(root).flatMap((path) =>
    actionPinsIn(readFileSync(path, "utf8")).map((p) => ({
      ...p,
      where: `${relative(root, path)}:${p.line}`,
    })),
  );

  it("is written once in the template of ocra init, and in both languages of the manual and the README", () => {
    expect(found.filter((p) => p.where.startsWith(`${ACTION_TEMPLATE}:`))).toHaveLength(1);
    expect(found.some((p) => p.where.startsWith("docs/manual/en/"))).toBe(true);
    expect(found.some((p) => p.where.startsWith("docs/manual/zh/"))).toBe(true);
    expect(found.some((p) => p.where.startsWith("README.md:"))).toBe(true);
    expect(found.some((p) => p.where.startsWith("README.zh-CN.md:"))).toBe(true);
  });

  it("names one commit and one version everywhere", () => {
    const template = found.find((p) => p.where.startsWith(`${ACTION_TEMPLATE}:`));
    const differ = found
      .filter(
        (p) =>
          p.version !== template?.version ||
          (p.commit !== "<commit>" && p.commit !== template?.commit),
      )
      .map((p) => `${p.where} ${p.commit} # v${p.version}`);
    expect(differ).toEqual([]);
  });
});

describe("unpinnedUses", () => {
  it("finds an action on a tag or branch, or on a commit without its version", () => {
    const text = `steps:
  - uses: actions/checkout@${NEW} # v7.0.1
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - name: upload
    uses: actions/upload-artifact@main
  - uses: jma49/Open-CR-Agent@<commit> # v0.6.0
  - uses: actions/cache@${NEW}
  - uses: ./.github/actions/setup
`;
    expect(unpinnedUses(text)).toEqual([
      { uses: "actions/checkout@v7", line: 3 },
      { uses: "actions/upload-artifact@main", line: 7 },
      { uses: `actions/cache@${NEW}`, line: 9 },
    ]);
  });
});

// A recipe is copied as it is: an action on a tag runs whatever the tag
// points at later (CWE-829).
describe("the workflows users copy or ocra init writes", () => {
  const files = recipeFiles(root);

  it("include both languages of the manual and the README, and ocra init's", () => {
    const names = files.map((path) => relative(root, path));
    expect(names).toEqual(
      expect.arrayContaining(["README.md", "README.zh-CN.md", "docs/manual/en/github.mdx"]),
    );
    expect(names.some((name) => name.endsWith("__snapshots__/ocra-fork-safe.yml"))).toBe(true);
  });

  it("pin every action to a commit", () => {
    const unpinned = files.flatMap((path) =>
      unpinnedUses(readFileSync(path, "utf8")).map(
        (u) => `${relative(root, path)}:${u.line} ${u.uses}`,
      ),
    );
    expect(unpinned).toEqual([]);
  });
});
