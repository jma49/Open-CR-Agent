import { describe, expect, it } from "vitest";
import * as core from "./index.js";

// The names the manual's Embedding page builds on. Renaming one is a
// contract change: say how in the changelog.
describe("the library entry", () => {
  it("exports what the Embedding page names", () => {
    for (const name of [
      "review",
      "startPlugins",
      "PluginRegistry",
      "toReportOutput",
      "reportOutputSchema",
      "reportJsonSchema",
      "coverageGaps",
      "isIncompleteReview",
      "isBlocking",
      "parseSarifLog",
      "correctnessReviewerPlugin",
      "securityReviewerPlugin",
      "performanceReviewerPlugin",
      "docsReviewerPlugin",
      "agentsMdReviewerPlugin",
      "sessionJsonlPlugin",
      "OcraError",
      "isOcraError",
      "OCRA_ERROR_CODES",
    ]) {
      expect(core, name).toHaveProperty(name);
    }
    expect(core).not.toHaveProperty("runReview");
  });
});
