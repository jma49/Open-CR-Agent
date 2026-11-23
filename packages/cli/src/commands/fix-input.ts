import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { sharedFindingSchema } from "@open-cr-agent/cloud-contract";
import { errorMessage, OcraError } from "@open-cr-agent/core";
import type { StoredFinding } from "@open-cr-agent/core/internal";
import type { z } from "zod";
import { UsageError } from "../io/usage-error.js";
import type { ReviewDeps } from "./review/deps.js";

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function expectedHead(value: string | undefined): string | undefined {
  if (value !== undefined && !COMMIT_ID.test(value)) {
    throw new UsageError("--head must be a full commit id (40 or 64 lowercase hex characters)");
  }
  return value;
}

export function maxCost(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const max = Number(value);
  if (!(max > 0)) throw new UsageError(`--max-cost-usd must be a positive number, got ${value}`);
  return max;
}

interface JsonInput<T> {
  flag: string;
  // What the flag's value is, for the refusal: "a finding".
  what: string;
  schema: z.ZodType<T>;
  maxBytes: number;
}

// A flag's JSON, from a file or from stdin (-), bounded before it is read.
export async function readJsonInput<T>(
  source: string,
  deps: ReviewDeps,
  input: JsonInput<T>,
): Promise<T> {
  const tooLarge = () =>
    new OcraError("INPUT_INVALID", `${input.flag} is over ${input.maxBytes} bytes`);
  let text: string;
  if (source === "-") {
    text = deps.readStdin
      ? await deps.readStdin(input.maxBytes)
      : await readStdin(input.maxBytes, tooLarge);
  } else {
    const path = resolve(deps.cwd, source);
    if ((await stat(path)).size > input.maxBytes) throw tooLarge();
    text = await readFile(path, "utf8");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new OcraError("INPUT_INVALID", `${input.flag} is not JSON: ${errorMessage(error)}`);
  }
  const parsed = input.schema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
    throw new OcraError(
      "INPUT_INVALID",
      `${input.flag} is not ${input.what}: ${fields.slice(0, 10).join(", ")}`,
    );
  }
  return parsed.data;
}

async function readStdin(max: number, tooLarge: () => Error): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > max) throw tooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function storedFinding(f: z.output<typeof sharedFindingSchema>): StoredFinding {
  return {
    fingerprint: f.fingerprint,
    reviewer: f.reviewer,
    severity: f.severity,
    category: f.category ?? "",
    file: f.file,
    title: f.title,
    body: f.body,
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    ...(f.code ? { existingCode: f.code } : {}),
    ...(f.lowConfidence ? { lowConfidence: true } : {}),
    ...(f.redacted || f.truncated ? { altered: true } : {}),
  };
}
