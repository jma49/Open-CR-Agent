import type { OcraPlugin } from "@open-cr-agent/core";
import { z } from "zod";
import { git } from "./git.js";
import { LocalGitAdapter } from "./local-adapter.js";

const optionsSchema = z.object({
  cwd: z.string().min(1),
  target: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("workspace") }),
    z.object({ mode: z.literal("range"), from: z.string().min(1), to: z.string().min(1) }),
    z.object({ mode: z.literal("commit"), commit: z.string().min(1) }),
  ]),
});

export const localGitPlugin: OcraPlugin = {
  name: "vcs-local",
  configure(ctx) {
    ctx.registerVcs("local", (options) => new LocalGitAdapter(optionsSchema.parse(options)));
  },
};

export async function findRepositoryRoot(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--show-toplevel"], { cwd })).trim();
}
