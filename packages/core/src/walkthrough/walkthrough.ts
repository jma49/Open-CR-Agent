import { parseJsonAnswer } from "../agent/json.js";
import { oneShot } from "../agent/model-call.js";
import type { AgentCallSettings } from "../agent/settings.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import type { ChangeRequest, FileDiff } from "../domain.js";
import { errorMessage, OcraError } from "../errors.js";
import { sequenceDiagram } from "./diagram.js";
import {
  buildWalkthroughPrompt,
  type WalkthroughResponse,
  walkthroughResponseSchema,
} from "./prompt.js";

// What the change does, for the people about to review it (ADR-0047).
export interface Walkthrough {
  overview: string;
  // Every selected file is in exactly one group, in reading order.
  groups: { title: string; files: string[]; note: string }[];
  // Mermaid source of a sequence diagram, when the flow needs one.
  diagram?: string;
}

const WALKTHROUGH_TIMEOUT_MS = 120_000;
const MAX_OVERVIEW_CHARS = 1_200;
const MAX_GROUPS = 12;
const MAX_TITLE_CHARS = 80;
const MAX_NOTE_CHARS = 500;
const OTHER_FILES = "Other changes";

export interface WalkthroughOptions {
  runtime: AgentRuntime;
  changeRequest: ChangeRequest;
  files: readonly FileDiff[];
  signal: AbortSignal;
  onUsage: (usage: Usage) => void;
  call?: AgentCallSettings | undefined;
}

export interface WalkthroughResult {
  walkthrough?: Walkthrough;
  warnings: string[];
}

// One plain completion. A failure costs the walkthrough, never the review.
export async function writeWalkthrough(options: WalkthroughOptions): Promise<WalkthroughResult> {
  const ask = oneShot(options.runtime, options.onUsage);
  if (!ask || options.files.length === 0) return { warnings: [] };
  const prompt = buildWalkthroughPrompt(options.changeRequest, options.files);
  try {
    const answer = await ask(
      {
        tier: "standard",
        agent: "writer",
        call: options.call,
        system: prompt.system,
        user: prompt.user,
        timeoutMs: WALKTHROUGH_TIMEOUT_MS,
      },
      options.signal,
    );
    const parsed = walkthroughResponseSchema.safeParse(parseJsonAnswer(answer));
    if (!parsed.success) {
      throw new OcraError("RUNTIME_INVALID_OUTPUT", "the walkthrough is not the expected JSON");
    }
    const walkthrough = fromResponse(parsed.data, options.files);
    if (!walkthrough) throw new OcraError("RUNTIME_INVALID_OUTPUT", "the walkthrough is empty");
    return { walkthrough, warnings: [] };
  } catch (error) {
    return { warnings: [`walkthrough failed, the summary has none: ${errorMessage(error)}`] };
  }
}

// The model groups the files; which files there are is the diff's to say.
// Unknown paths are dropped, a file claimed twice stays in its first group,
// and files left out are listed under one more group.
export function fromResponse(
  response: WalkthroughResponse,
  files: readonly FileDiff[],
): Walkthrough | undefined {
  const overview = clip(response.overview.trim(), MAX_OVERVIEW_CHARS);
  if (overview === "") return undefined;
  const paths = files.map((f) => f.newPath);
  const unclaimed = new Set(paths);
  const groups: Walkthrough["groups"] = [];
  for (const group of response.groups.slice(0, MAX_GROUPS)) {
    const claimed = [...new Set(group.files.map((p) => p.replace(/^\.\//, "")))].filter((p) =>
      unclaimed.delete(p),
    );
    if (claimed.length === 0) continue;
    groups.push({
      title: clip(oneLineOf(group.title), MAX_TITLE_CHARS) || OTHER_FILES,
      files: claimed,
      note: clip(oneLineOf(group.note), MAX_NOTE_CHARS),
    });
  }
  const rest = paths.filter((p) => unclaimed.has(p));
  if (rest.length > 0) groups.push({ title: OTHER_FILES, files: rest, note: "" });
  const diagram = sequenceDiagram(response.diagram);
  return { overview, groups, ...(diagram ? { diagram } : {}) };
}

function oneLineOf(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
