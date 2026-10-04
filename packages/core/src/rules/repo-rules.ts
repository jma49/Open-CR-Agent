import { z } from "zod";
import { OcraError } from "../errors.js";

export const repoRuleSchema = z.object({
  path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  rule: z.string().min(1),
});
export type RepoRule = z.infer<typeof repoRuleSchema>;

export const repoRulesFileSchema = z.object({ rules: z.array(repoRuleSchema) });

export const REPO_RULES_PATH = ".ocra/rules.json";

export function parseRepoRules(json: string): RepoRule[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new OcraError(
      "CONFIG_INVALID",
      `${REPO_RULES_PATH} is not valid JSON: ${(error as Error).message}`,
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
