import { z } from "zod";

// What a caller outside the terminal (ocra serve, ocra mcp) may ask of a
// review: it can only narrow one, never widen what it may do.
const ref = z
  .string()
  .regex(/^[\w./~^@{}-]{1,200}$/)
  .refine((r) => !r.startsWith("-"), "a ref cannot start with -");

export const runRequestSchema = z
  .object({
    target: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("workspace") }),
        z.object({ mode: z.literal("range"), from: ref, to: ref.default("HEAD") }),
        z.object({ mode: z.literal("commit"), commit: ref }),
      ])
      .default({ mode: "workspace" }),
    reviewers: z
      .array(z.string().regex(/^[A-Za-z0-9][\w.:@-]{0,99}$/))
      .min(1)
      .max(20)
      .optional(),
    maxCostUsd: z.number().positive().max(1_000).optional(),
  })
  .strict();
export type RunRequest = z.infer<typeof runRequestSchema>;
