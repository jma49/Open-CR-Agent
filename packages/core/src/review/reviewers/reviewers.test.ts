import { describe, expect, it } from "vitest";
import { agentsMdReviewer } from "./agents-md.js";
import { correctnessReviewer } from "./correctness.js";
import { docsReviewer } from "./docs.js";
import { performanceReviewer } from "./performance.js";
import { securityReviewer } from "./security.js";

const builtIn = [
  correctnessReviewer,
  securityReviewer,
  performanceReviewer,
  docsReviewer,
  agentsMdReviewer,
];

describe("built-in reviewer prompts", () => {
  it.each(builtIn.map((r) => [r.id, r.systemPrompt]))(
    "%s names only ocra's tags and says only they are ocra's",
    (_id, prompt) => {
      expect(prompt).toContain("Only tags that start with <ocra_ are ocra's");
      // A section named without the prefix no longer exists in the prompt.
      expect(prompt.match(/<\/?(?!ocra_)[a-z_]+>/g) ?? []).toEqual([]);
    },
  );
});
