import { z } from "zod";
import { errorMessage, OcraError } from "../errors.js";

export const repoRuleSchema = z.object({
  path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  rule: z.string().min(1),
});
export type RepoRule = z.infer<typeof repoRuleSchema>;

// Where a rule came from, recorded in the report: the reviewed repository's
// .ocra/rules.json, a shared configuration (extends), the user's ocra Cloud
// account (ADR-0027) or a plugin.
export type RuleSource = "repository" | "shared" | "account" | "plugin";
export type SourcedRule = RepoRule & { source?: RuleSource };

const repoRulesFileSchema = z.object({ rules: z.array(repoRuleSchema) });

export const REPO_RULES_PATH = ".ocra/rules.json";

export function parseRepoRules(json: string): RepoRule[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new OcraError(
      "CONFIG_INVALID",
      `${REPO_RULES_PATH} is not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const parsed = repoRulesFileSchema.safeParse(data);
  if (!parsed.success) {
    throw new OcraError(
      "CONFIG_INVALID",
      `${REPO_RULES_PATH} is invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data.rules;
}
