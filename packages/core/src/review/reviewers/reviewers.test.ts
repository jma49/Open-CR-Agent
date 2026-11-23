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
    "%s names only ocra's tags",
    (_id, prompt) => {
      // A section named without the prefix no longer exists in the prompt.
      expect(prompt.match(/<\/?(?!ocra_)[a-z_]+>/g) ?? []).toEqual([]);
    },
  );
});
