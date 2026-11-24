import {
  type AttemptError,
  type AttemptOutcome,
  exploredBy,
  parseQuotaError,
  REVIEW_TOOLS,
  type ToolUse,
  type Usage,
} from "@open-cr-agent/core";
import { z } from "zod";
import { OCRA_SERVER } from "./exec-args.js";

// The lines of `codex exec --json` ocra reads, validated rather than cast: a
// Codex of another version may answer in another shape. Unknown fields are
// dropped, and a line that does not fit is counted, not fatal.
const usageSchema = z.object({
  input_tokens: z.number().optional(),
  cached_input_tokens: z.number().optional(),
  cache_write_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  reasoning_output_tokens: z.number().optional(),
});

const itemSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  arguments: z.unknown().optional(),
  status: z.string().optional(),
});

const eventSchema = z.object({
  type: z.string(),
  item: itemSchema.optional(),
  usage: usageSchema.optional(),
  message: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

// Items that carry no tool of Codex's own. Any other item (a shell command, a
// file change, a web search, another MCP server's tool) means Codex used a
// tool ocra switched off, and the attempt stops.
const QUIET_ITEMS = new Set(["agent_message", "reasoning", "error", "todo_list"]);

const AUTH_MESSAGE =
  /not logged in|log ?in again|unauthori[sz]ed|\b401\b|\b403\b|refresh token|forbidden/i;
const USAGE_LIMIT = /usage limit/i;

// One attempt's events, folded as they arrive.
export class ExecTally {
  private readonly texts: string[] = [];
  private readonly uses: ToolUse[] = [];
  private readonly names: string[] = [];
  private readonly findings: unknown[] = [];
  private spent: Usage = emptyUsage();
  private failure: string | undefined;
  private unread = 0;
  // The first tool of Codex's own it used, by item type.
  foreign: string | undefined;

  // True when the line changed what the attempt has spent.
  push(line: string): boolean {
    if (line.trim() === "") return false;
    const parsed = eventSchema.safeParse(parseJson(line));
    if (!parsed.success) {
      this.unread += 1;
      return false;
    }
    const event = parsed.data;
    switch (event.type) {
      case "item.completed":
        if (event.item) this.completed(event.item);
        return false;
      case "item.started":
        if (event.item && this.isForeign(event.item)) this.foreign ??= event.item.type;
        return false;
      case "turn.completed":
        this.spent = addUsage(this.spent, event.usage);
        return true;
      case "turn.failed":
        this.failure = event.error?.message ?? this.failure ?? "Codex failed the turn";
        return false;
      case "error":
        this.failure = event.message ?? this.failure;
        return false;
      default:
        return false;
    }
  }

  get toolCalls(): number {
    return this.names.length;
  }

  get usage(): Usage {
    return this.spent;
  }

  outcome(): AttemptOutcome {
    const outcome: AttemptOutcome = {
      findings: [...this.findings],
      // Codex does not report its model requests: one per tool call and one
      // per message stands in for them.
      steps: this.names.length + this.texts.length,
      toolCalls: [...this.names],
      ...exploredBy(this.uses),
      text: this.texts.join("\n").trim(),
      usage: this.spent,
    };
    if (this.failure !== undefined) outcome.error = codexError(this.failure);
    if (this.unread > 0) outcome.unreadMessages = this.unread;
    return outcome;
  }

  private completed(item: z.output<typeof itemSchema>): void {
    if (item.type === "agent_message") {
      if (item.text) this.texts.push(item.text);
      return;
    }
    if (this.isForeign(item)) {
      this.foreign ??= item.type;
      return;
    }
    if (item.type !== "mcp_tool_call" || item.tool === undefined) return;
    this.names.push(item.tool);
    // A failed call, the tool's own refusal included, never showed the
    // reviewer anything and reported nothing.
    if (item.status !== "completed") return;
    this.uses.push({ name: item.tool, input: item.arguments });
    if (item.tool === REVIEW_TOOLS.reportFinding) this.findings.push(item.arguments);
  }

  private isForeign(item: z.output<typeof itemSchema>): boolean {
    if (QUIET_ITEMS.has(item.type)) return false;
    return item.type !== "mcp_tool_call" || item.server !== OCRA_SERVER;
  }
}

// How a Codex failure counts for the model chain. A usage limit is the
// account's window, which no wait inside a run outlasts; a sign-in problem
// would fail on every model.
export function codexError(message: string): AttemptError {
  if (AUTH_MESSAGE.test(message)) return { message, retryable: false };
  if (USAGE_LIMIT.test(message)) return { message, retryable: true, quota: { daily: true } };
  const quota = parseQuotaError(message);
  return quota ? { message, retryable: true, quota } : { message, retryable: true };
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 };
}

// Codex counts cached input inside its input tokens; the engine counts it
// apart. The account pays, not ocra, so the cost is 0.
function addUsage(total: Usage, turn: z.output<typeof usageSchema> | undefined): Usage {
  if (!turn) return total;
  const input = turn.input_tokens ?? 0;
  const cached = Math.min(input, turn.cached_input_tokens ?? 0);
  return {
    inputTokens: total.inputTokens + input - cached,
    outputTokens: total.outputTokens + (turn.output_tokens ?? 0),
    reasoningTokens: total.reasoningTokens + (turn.reasoning_output_tokens ?? 0),
    cachedTokens: total.cachedTokens + cached,
    costUsd: 0,
  };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
