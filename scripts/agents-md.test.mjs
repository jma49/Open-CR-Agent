import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
const MAX_LINES = 150;
// The same constant sits in ocra-cloud and ocra-site: change all three together.
const SHARED_SECTION_SHA256 = "ee6d49ce0c2492effb1328fbea319f8ed19cc2a12c7fa798f20201c491535485";

// AGENTS.md is read by every agent session: it stays short, and what it says
// about the checks stays true as the checks change.
describe("AGENTS.md", () => {
  it(`has under ${MAX_LINES} lines`, () => {
    expect(agents.trimEnd().split("\n").length).toBeLessThan(MAX_LINES);
  });

  it("names every step npm run verify runs", () => {
    const steps = [...scripts.verify.matchAll(/npm (?:run )?([\w:-]+)/g)].map((m) => m[1]);
    expect(steps.length).toBeGreaterThan(2);
    for (const step of steps)
      expect(agents, step).toContain(step === "test" ? "every test" : `\`${step}\``);
  });

  it("names the fast test loop and the e2e convention", () => {
    expect(scripts["test:unit"]).toBeDefined();
    expect(agents).toContain("`npm run test:unit`");
    expect(agents).toContain("`*.e2e.test.ts`");
  });

  it("carries the section mirrored in ocra-cloud and ocra-site, word for word", () => {
    const section = agents.match(
      /^## Working with agents\n[\s\S]*?(?=^## |^<!-- |(?![\s\S]))/m,
    )?.[0];
    expect(section).toBeDefined();
    const hash = createHash("sha256")
      .update(section?.trim() ?? "")
      .digest("hex");
    expect(hash).toBe(SHARED_SECTION_SHA256);
  });
});
