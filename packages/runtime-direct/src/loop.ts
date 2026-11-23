import {
  type AttemptOutcome,
  addUsage,
  emptyUsage,
  errorMessage,
  exploredBy,
  type ModelPrice,
  type RateLimits,
  REVIEW_TOOLS,
  type ReviewContext,
  type TaskAttempt,
  type ToolDefinition,
  type ToolUse,
  type Usage,
} from "@open-cr-agent/core";
import {
  type Answer,
  type CallSettings,
  type Dialogue,
  type Endpoint,
  type ToolRequest,
  type Wire,
  withoutEffort,
} from "./wire.js";

export interface LoopInput {
  wire: Wire;
  endpoint: Endpoint;
  model: string;
  price: ModelPrice;
  system: string;
  user: string;
  // AgentTaskSpec.sharedPrefixes of `user`.
  shared?: readonly number[];
  tools: readonly ToolDefinition[];
  context: ReviewContext;
  // Model requests the attempt may make.
  maxSteps: number;
  // DialogueStart.oneRequest: a completion.
  oneRequest?: boolean;
  // Review agents only: sent once when the agent stops with steps left, no
  // done call and no answer.
  resume?: string;
  // Review agents only: the turn the attempt offers as TaskAttempt.wrapUp.
  wrapUp?: WrapUpTurn;
  timeoutMs: number;
  // Sent with every request, until the endpoint refuses the effort in them.
  settings?: CallSettings;
  // The endpoint refused the effort; the rest of the attempt goes without it.
  onEffortRefused?: () => void;
  // DialogueStart.textTools.
  textTools?: boolean;
  // The endpoint refused the tools; the rest of the attempt calls them as text.
  onToolsRefused?: () => void;
  signal: AbortSignal;
  onUsage?: (spent: Usage) => void;
  // Review agents only: a rate-limited request waits and is sent again.
  limits?: RateLimits;
}

interface WrapUpTurn {
  message: string;
  // Names of the tools the turn offers, of those the attempt has.
  tools: readonly string[];
  steps: number;
}

// The agent loop: ask the model, run the tools it calls against the review
// context, hand the results back, until it calls task_done, answers without
// tools, or runs out of steps. The model reaches nothing but these tools and
// the endpoint; a finding is what it passes to report_finding, kept as given
// for the pipeline to validate.
export async function runLoop(input: LoopInput): Promise<TaskAttempt> {
  const conversation = new Conversation(input);
  const outcome = await conversation.turn(
    { text: input.user, ...(input.shared ? { shared: input.shared } : {}) },
    input.tools,
    input.maxSteps,
    input.resume,
  );
  const { wrapUp } = input;
  if (!wrapUp) return outcome;
  const tools = input.tools.filter((t) => wrapUp.tools.includes(t.name));
  return {
    ...outcome,
    wrapUp: () => conversation.turn({ text: wrapUp.message }, tools, outcome.steps + wrapUp.steps),
  };
}

// One attempt's dialogue and outcome, which a later turn continues under the
// attempt's signal and timeout.
class Conversation {
  private readonly input: LoopInput;
  private readonly timeout: AbortSignal;
  private readonly signal: AbortSignal;
  private readonly dialogue: Dialogue;
  private readonly outcome: AttemptOutcome = {
    findings: [],
    steps: 0,
    toolCalls: [],
    text: "",
    usage: emptyUsage(),
  };
  private readonly texts: string[] = [];
  private readonly uses: ToolUse[] = [];
  private settings: CallSettings;

  constructor(input: LoopInput) {
    this.input = input;
    this.timeout = AbortSignal.timeout(input.timeoutMs);
    this.signal = AbortSignal.any([input.signal, this.timeout]);
    this.dialogue = input.wire(input);
    this.settings = input.settings ?? {};
  }

  // Runs until the done tool, an answer without tools, or `maxSteps` steps
  // in the whole attempt; returns the attempt's outcome so far.
  async turn(
    message: { text: string; shared?: readonly number[] },
    offered: readonly ToolDefinition[],
    maxSteps: number,
    resume?: string,
  ): Promise<AttemptOutcome> {
    const { input, dialogue, outcome, texts, uses } = this;
    const tools = new Map(offered.map((t) => [t.name, t]));
    let done = false;
    dialogue.say(message.text, message.shared);
    while (outcome.steps < maxSteps) {
      const response = await this.ask(offered);
      outcome.steps += 1;
      if (!response.ok) {
        outcome.error = this.timeout.aborted
          ? { message: `timed out after ${Math.round(input.timeoutMs / 1000)}s`, retryable: true }
          : response.error;
        break;
      }
      outcome.usage = addUsage(outcome.usage, response.usage);
      input.onUsage?.(outcome.usage);
      if (response.text) texts.push(response.text);

      // A completion's tools are only there to match a task's request.
      if (input.oneRequest) break;
      if (response.calls.length === 0) {
        const stoppedEarly = resume && !outcome.resumed && texts.join("").trim() === "";
        if (stoppedEarly && outcome.steps < maxSteps) {
          outcome.resumed = true;
          dialogue.say(resume);
          continue;
        }
        break;
      }
      // Together, as OpenCode runs a step's calls, so its searches share one
      // grep; each call is recorded as it starts, in the order given.
      const outputs = await Promise.all(
        response.calls.map(async (call) => {
          outcome.toolCalls.push(call.name);
          if (call.name === REVIEW_TOOLS.taskDone) done = true;
          return { call, output: await runTool(tools, call, input.context, outcome, uses) };
        }),
      );
      dialogue.answer(outputs);
      if (done) break;
    }
    outcome.text = texts.join("\n").trim();
    if (!done && !outcome.error && outcome.steps >= maxSteps) outcome.atStepCap = true;
    else delete outcome.atStepCap;
    return { ...snapshot(outcome), ...exploredBy(uses) };
  }

  // One step's answer. A request the endpoint rate-limits is sent again once
  // the model's pause is over: the conversation is kept, where a new attempt
  // would ask and pay for every step before it again.
  private async ask(offered: readonly ToolDefinition[]): Promise<Answer> {
    for (;;) {
      const response = await this.dialogue.ask(offered, this.settings, this.signal);
      if (response.effortDropped) {
        this.settings = withoutEffort(this.settings);
        this.input.onEffortRefused?.();
      }
      if (response.toolsDropped) this.input.onToolsRefused?.();
      const quota = response.ok ? undefined : response.error.quota;
      if (!quota || this.signal.aborted || !(await this.input.limits?.waitOut(quota))) {
        return response;
      }
    }
  }
}

// A later turn adds to the outcome; what an earlier turn returned stays as
// it was.
function snapshot(outcome: AttemptOutcome): AttemptOutcome {
  return { ...outcome, findings: [...outcome.findings], toolCalls: [...outcome.toolCalls] };
}

// A tool's answer, or why it gave none: a wrong call is told to the model,
// which may correct it, and never ends the attempt.
async function runTool(
  tools: ReadonlyMap<string, ToolDefinition>,
  call: ToolRequest,
  context: ReviewContext,
  outcome: AttemptOutcome,
  uses: ToolUse[],
): Promise<string> {
  const tool = tools.get(call.name);
  if (!tool) return `Unknown tool: ${call.name}`;
  if (call.malformed) return "Invalid arguments: not JSON";
  const parsed = tool.inputSchema.safeParse(call.input);
  if (!parsed.success) {
    return `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
  }
  uses.push({ name: tool.name, input: parsed.data });
  if (tool.name === REVIEW_TOOLS.reportFinding) outcome.findings.push(parsed.data);
  try {
    return await tool.execute(parsed.data, context);
  } catch (error) {
    return `Tool failed: ${errorMessage(error)}`;
  }
}
