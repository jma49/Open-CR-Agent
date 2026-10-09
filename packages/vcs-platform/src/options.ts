import { z } from "zod";
import type { PlatformChangeRequest } from "./platform.js";
import type { CodeSource, History } from "./review.js";

// What every platform adapter's registry options share. The code source and
// the history are ports the caller implements, so only their shape can be
// checked; the change request is data and is validated in full.

const hasMethods = (value: unknown, methods: readonly string[]): boolean =>
  typeof value === "object" &&
  value !== null &&
  methods.every((m) => typeof (value as Record<string, unknown>)[m] === "function");

export const codeSourceSchema = z.custom<CodeSource>(
  (value) => hasMethods(value, ["getDiff", "readFile", "searchCode"]),
  "code must provide getDiff, readFile and searchCode",
);

export const historySchema = z.custom<History>(
  (value) => hasMethods(value, ["filesChangedSince"]),
  "history must provide filesChangedSince",
);

export const fetchSchema = z.custom<typeof fetch>((value) => typeof value === "function");

export const signalSchema = z.instanceof(AbortSignal);

// Commit ids reach git as arguments; anything else is refused at the boundary.
export const commitIdSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "not a commit id");

// The change request as the diff under review was built from it.
export const changeRequestSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string(),
  baseSha: commitIdSchema,
  headSha: commitIdSchema,
  author: z.string().exactOptional(),
}) satisfies z.ZodType<PlatformChangeRequest>;
