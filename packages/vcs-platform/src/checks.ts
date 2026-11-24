import type { ChangeChecks, FailedCheck } from "@open-cr-agent/core";
import { CHECK_LIMITS, logTail } from "@open-cr-agent/core/internal";
import type { ReviewPlatform } from "./platform.js";

// How much of a job's log a platform is asked for: well over the lines a
// round keeps, with their timestamps.
export const LOG_TAIL_BYTES = 256 * 1024;

// What holds for a change request's failed checks on every platform
// (ADR-0078 point 3): a check that also fails on the base branch's head is
// not the change's to fix, only the first few are read, and a log is cut
// before anything else sees it.
export async function checksOfChange(
  platform: Pick<ReviewPlatform, "checks" | "failingOnBase">,
  headSha: string,
): Promise<ChangeChecks> {
  const checks = await platform.checks(headSha);
  const pending = checks.some((c) => c.state === "pending");
  const names = new Set<string>();
  const failing = checks.filter(
    (c) => c.state === "failed" && !names.has(c.name) && names.add(c.name),
  );
  if (failing.length === 0) return { pending, failed: [] };
  const onBase = new Set(await platform.failingOnBase());
  const failed: FailedCheck[] = [];
  for (const check of failing.filter((c) => !onBase.has(c.name)).slice(0, CHECK_LIMITS.checks)) {
    failed.push({ name: check.name, log: logTail(await check.log()) });
  }
  return { pending, failed };
}
