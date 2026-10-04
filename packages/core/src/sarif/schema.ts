import { z } from "zod";
import { OcraError } from "../errors.js";

// The part of SARIF 2.1.0 an import reads. Objects are loose: a log carries
// far more than this, and none of it is trusted beyond what is checked here.
// https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html

const message = z.looseObject({ text: z.string().optional() });

const region = z.looseObject({
  startLine: z.int().positive(),
  endLine: z.int().positive().optional(),
  snippet: z.looseObject({ text: z.string().optional() }).optional(),
});

const location = z.looseObject({
  physicalLocation: z
    .looseObject({
      artifactLocation: z
        .looseObject({ uri: z.string(), uriBaseId: z.string().optional() })
        .optional(),
      region: region.optional(),
    })
    .optional(),
});

const rule = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  shortDescription: message.optional(),
  fullDescription: message.optional(),
  helpUri: z.string().optional(),
  defaultConfiguration: z.looseObject({ level: z.string().optional() }).optional(),
});

const result = z.looseObject({
  ruleId: z.string().optional(),
  ruleIndex: z.int().nonnegative().optional(),
  level: z.string().optional(),
  message,
  locations: z.array(location).optional(),
});

export const sarifRunSchema = z.looseObject({
  tool: z.looseObject({
    driver: z.looseObject({
      name: z.string().min(1),
      version: z.string().optional(),
      semanticVersion: z.string().optional(),
      rules: z.array(rule).optional(),
    }),
  }),
  results: z.array(result).optional(),
});

export const sarifLogSchema = z.looseObject({
  version: z.literal("2.1.0"),
  runs: z.array(sarifRunSchema),
});

export type SarifLog = z.infer<typeof sarifLogSchema>;
export type SarifRun = z.infer<typeof sarifRunSchema>;
export type SarifResult = z.infer<typeof result>;
export type SarifRule = z.infer<typeof rule>;

export class SarifError extends OcraError {
  constructor(message: string) {
    super("INPUT_INVALID", message);
    this.name = "SarifError";
  }
}

export function parseSarifLog(text: string): SarifLog {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new SarifError(`not valid JSON: ${(error as Error).message}`);
  }
  const parsed = sarifLogSchema.safeParse(data);
  if (!parsed.success)
    throw new SarifError(`not a SARIF 2.1.0 log: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
