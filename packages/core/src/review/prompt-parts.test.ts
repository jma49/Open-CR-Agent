import { describe, expect, it } from "vitest";
import { contextInput } from "./context.fakes.js";
import { OPTIONAL_CONTEXT, type OptionalContext } from "./context-sources.js";
import { buildReviewPrompt, reviewPromptParts } from "./prompt.js";

const sourceOf: Record<OptionalContext, string> = {
  description: "change_request",
  changed_files: "changed_files",
  linked_tasks: "linked_tasks",
  guidelines: "guidelines",
  rules: "rules",
  accepted: "accepted",
  learnings: "learnings",
  project_docs: "project_docs",
  callers: "callers",
  analyzer: "analyzer",
};

describe("reviewPromptParts", () => {
  it("is the prompt buildReviewPrompt sends, part by part", () => {
    const input = contextInput("small");
    const [system, ...user] = reviewPromptParts(input);
    const prompt = buildReviewPrompt(input);
    expect(prompt.system).toBe(system?.text);
    expect(prompt.user).toBe(user.map((p) => p.text).join("\n\n"));
    expect(reviewPromptParts(input).map((p) => p.source)).toEqual([
      "system",
      "change_request",
      "changed_files",
      "linked_tasks",
      "guidelines",
      "accepted",
      "learnings",
      "project_docs",
      "diff",
      "callers",
      "analyzer",
      "reviewer_brief",
      "rules",
      "instructions",
    ]);
  });

  it.each(OPTIONAL_CONTEXT)("leaves out %s and nothing else", (left) => {
    const input = contextInput("small");
    const all = reviewPromptParts(input);
    const parts = reviewPromptParts({ ...input, without: new Set([left]) });
    const changed = all.filter(
      (p, i) => parts.find((q) => q.source === p.source)?.text !== all[i]?.text,
    );
    expect(changed.map((p) => p.source)).toEqual([sourceOf[left]]);
  });

  it("keeps the title when the description is left out", () => {
    const input = contextInput("small");
    const parts = reviewPromptParts({ ...input, without: new Set(["description"]) });
    const request = parts.find((p) => p.source === "change_request")?.text ?? "";
    expect(request).toContain("<ocra_title>");
    expect(request).not.toContain("<ocra_description>");
  });

  it("leaves out only the repository's rules, not the reviewer's", () => {
    const input = contextInput("small");
    const parts = reviewPromptParts({ ...input, without: new Set(["rules"]) });
    const rules = parts.find((p) => p.source === "rules")?.text ?? "";
    expect(rules).toContain("- rule");
    expect(rules).not.toContain("### Repository rules");
  });
});
