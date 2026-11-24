import type { ReviewContext } from "../contracts.js";
import type { FileDiff } from "../domain.js";
import type { CallFailure } from "../errors.js";
import type { AgentItem } from "../mend/agent-lane.js";
import { gate, type MendScope } from "../mend/gate.js";
import type { ItemOutcome, ItemReason } from "../mend/outcomes.js";
import type { ItemPatch } from "../mend/patch.js";
import { MEND_LIMITS } from "../mend/state.js";
import type { VerificationStep } from "../mend/verify.js";
import type { FailedCheck } from "../vcs.js";
import { fixAtHead, type StoredFinding } from "./fix-finding.js";
import { agentPatch } from "./mend-agent.js";

// One thing a round works on: a finding a person accepted, or a check that
// failed on the head.
export type WorkItem = { id: string; finding: StoredFinding } | { id: string; check: FailedCheck };

export interface Head {
  diffs: readonly FileDiff[];
  context: ReviewContext;
  scope: MendScope;
  contents: Map<string, string>;
}

export type Attempt =
  | { patch: ItemPatch }
  | { outcome: ItemOutcome; reason: ItemReason; cause?: CallFailure };

// A person decides these: no later round at this head answers differently.
const FOR_A_PERSON: ReadonlySet<ItemReason> = new Set<ItemReason>([
  "not_candidate",
  "no_parser",
  "out_of_scope",
  "protected",
  "too_large",
  "tamper",
]);

// Why the local lane wrote nothing for a finding an edit may still fix: it
// spans more than the lane takes, or needs lines elsewhere.
const NOT_LOCAL: ReadonlySet<ItemReason> = new Set<ItemReason>([
  "not_candidate",
  "declined",
  "too_large",
]);

export interface AttemptDeps extends Omit<Parameters<typeof fixAtHead>[1], "diffs" | "context"> {
  onWarning: (warning: string) => void;
}

// One item through its lane, the gate and the verification steps.
export async function attempt(
  item: WorkItem,
  head: Head,
  steps: readonly VerificationStep[],
  deps: AttemptDeps,
): Promise<Attempt> {
  const refuse = (reason: ItemReason, cause?: CallFailure): Attempt => ({
    outcome: reason === "stale" ? "gone" : FOR_A_PERSON.has(reason) ? "needs_human" : "rejected",
    reason,
    ...(cause ? { cause } : {}),
  });
  if ("finding" in item) {
    const outside = head.scope.refusal(item.finding.file);
    if (outside) return refuse(outside);
  }
  const written =
    "finding" in item
      ? await write(item.finding, head, deps)
      : await writeForCheck(item.id, item.check, head, deps);
  if (!("patch" in written)) {
    return written.reason === "no_room"
      ? { outcome: "deferred", reason: "no_room" }
      : refuse(written.reason, written.cause);
  }
  const { patch } = written;
  const gated = await gate(patch, head.contents, head.scope, deps.syntax, MEND_LIMITS);
  if (gated) return refuse(gated);
  const subject =
    "finding" in item
      ? { title: item.finding.title, body: item.finding.body }
      : { title: `The check "${item.check.name}" fails on this change`, body: item.check.log };
  for (const step of steps) {
    if (!deps.spendLimit.mayCall()) return { outcome: "deferred", reason: "no_room" };
    const refused = await step({ ...subject, patch, heads: head.contents }, deps.signal);
    if (refused) return refuse(refused);
  }
  return { patch };
}

type Written = { patch: ItemPatch } | { reason: ItemReason; cause?: CallFailure };

// The patch for a failed check: only a task that can read the code the log
// names writes one, so a runtime without tasks' own tools, or a check that
// gave no log, leaves it to a person.
async function writeForCheck(
  id: string,
  check: FailedCheck,
  head: Head,
  deps: AttemptDeps,
): Promise<Written> {
  if (!deps.runtime.toolsets || check.log === "") return { reason: "not_candidate" };
  const changed = head.diffs.flatMap((d) => (d.newPath ? [d.newPath] : []));
  return fromAgent(
    { id, title: check.name, body: "", check: { log: check.log, changed } },
    head,
    deps,
  );
}

async function fromAgent(item: AgentItem, head: Head, deps: AttemptDeps): Promise<Written> {
  const edited = await agentPatch(item, { ...deps, context: head.context, scope: head.scope });
  if (!("patch" in edited)) {
    if (edited.warning) deps.onWarning(edited.warning);
    return edited;
  }
  for (const [path, content] of edited.heads) head.contents.set(path, content);
  return edited;
}

// The patch for one finding, by the smallest lane that can write it: the fix
// stage's completion for a local edit, else a task with the edit tool, where
// the runtime runs one.
async function write(finding: StoredFinding, head: Head, deps: AttemptDeps): Promise<Written> {
  const fixed = await fixAtHead(finding, { ...deps, diffs: head.diffs, context: head.context });
  for (const warning of fixed.warnings) deps.onWarning(warning);
  if ("fix" in fixed) {
    const content = await head.context.readFile(finding.file);
    if (content === undefined) return { reason: "stale" };
    head.contents.set(finding.file, content);
    return {
      patch: { item: finding.fingerprint, hunks: [{ path: finding.file, ...fixed.fix }] },
    };
  }
  if (!deps.runtime.toolsets || !NOT_LOCAL.has(fixed.reason)) return fixed;
  return fromAgent(
    {
      id: finding.fingerprint,
      file: finding.file,
      title: finding.title,
      body: finding.body,
      code: finding.existingCode,
      suggestion: finding.suggestion,
    },
    head,
    deps,
  );
}
