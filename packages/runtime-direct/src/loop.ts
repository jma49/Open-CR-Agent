import {
  type AttemptError,
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
import type { SharedStarts } from "./shared-starts.js";
import { TURN_HEADROOM, WindowGauge } from "./window.js";
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
  // The model's context window in tokens, when its declaration has one.
  contextWindow?: number;
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
  // DialogueStart.starts.
  starts?: SharedStarts;
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
    { resume: input.resume, headroom: TURN_HEADROOM },
  );
  const { wrapUp } = input;
  if (!wrapUp) return outcome;
  const tools = input.tools.filter((t) => wrapUp.tools.includes(t.name));
  return {
    ...outcome,
    wrapUp: () =>
      conversation.turn({ text: wrapUp.message }, tools, outcome.steps + wrapUp.steps, {
        headroom: 0,
      }),
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
  private readonly refusals: { fields: string; file: string | undefined }[] = [];
  private settings: CallSettings;
  private readonly gauge: WindowGauge;

  constructor(input: LoopInput) {
    this.input = input;
    this.gauge = new WindowGauge(input.contextWindow);
    this.gauge.said(input.system);
    this.timeout = AbortSignal.timeout(input.timeoutMs);
    this.signal = AbortSignal.any([input.signal, this.timeout]);
    this.dialogue = input.wire(input);
    this.settings = input.settings ?? {};
  }

  // An accepted report answers a refused one for the same file, or one whose
  // file could not be read; a refusal for another file stays on record.
  private sentAgain(file: string | undefined): void {
    const index = this.refusals.findIndex((r) => r.file === undefined || r.file === file);
    if (index >= 0) this.refusals.splice(index, 1);
  }

  // Runs until the done tool, an answer without tools, `maxSteps` steps in
  // the whole attempt, or a context window with less than `headroom` of it
  // left; returns the attempt's outcome so far.
  async turn(
    message: { text: string; shared?: readonly number[] },
    offered: readonly ToolDefinition[],
    maxSteps: number,
    { resume, headroom }: { resume?: string | undefined; headroom: number },
  ): Promise<AttemptOutcome> {
    const { input, dialogue, outcome, texts, uses, gauge } = this;
    const tools = new Map(offered.map((t) => [t.name, t]));
    let done = false;
    let windowFull = false;
    dialogue.say(message.text, message.shared);
    gauge.said(message.text);
    while (outcome.steps < maxSteps) {
      if (gauge.full(headroom)) {
        if (outcome.steps === 0) outcome.error = this.tooLarge();
        else windowFull = true;
        break;
      }
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
      gauge.answered(response.usage, response.text);
      if (response.text) texts.push(response.text);

      // A completion's tools are only there to match a task's request.
      if (input.oneRequest) break;
      if (response.calls.length === 0) {
        const stoppedEarly = resume && !outcome.resumed && texts.join("").trim() === "";
        if (stoppedEarly && outcome.steps < maxSteps) {
          outcome.resumed = true;
          dialogue.say(resume);
          gauge.said(resume);
          continue;
        }
        break;
      }
      // Together, as OpenCode runs a step's calls, so its searches share one
      // grep; each call is recorded as it starts, in the order given.
      const outputs = await Promise.all(
        response.calls.map(async (call) => {
          outcome.toolCalls.push(call.name);
          return { call, ...(await runTool(tools, call, input.context, outcome, uses)) };
        }),
      );
      dialogue.answer(outputs);
      for (const { output } of outputs) gauge.said(output);
      // A finding sent in the same answer as task_done and refused for its
      // arguments was lost without a word: the task goes on, so the model
      // reads why and can send it again.
      const reports = outputs.filter(({ call }) => call.name === REVIEW_TOOLS.reportFinding);
      const refused = reports.filter((report) => report.refused !== undefined);
      for (const report of reports) {
        if (report.refused === undefined) this.sentAgain(reportedFile(report.call));
      }
      for (const { call, refused: fields = "" } of refused) {
        this.refusals.push({ fields, file: reportedFile(call) });
      }
      if (this.refusals.length > 0) outcome.refusedFindings = this.refusals.map((r) => r.fields);
      else delete outcome.refusedFindings;
      done =
        outputs.some(({ call }) => call.name === REVIEW_TOOLS.taskDone) && refused.length === 0;
      if (done) break;
    }
    outcome.text = texts.join("\n").trim();
    const unfinished = !done && !outcome.error;
    if (unfinished && outcome.steps >= maxSteps) outcome.atStepCap = true;
    else delete outcome.atStepCap;
    if (unfinished && windowFull) outcome.atContextWindow = true;
    else delete outcome.atContextWindow;
    return { ...snapshot(outcome), ...exploredBy(uses) };
  }

  // The first request would not fit: another model of the chain may hold it.
  private tooLarge(): AttemptError {
    const { model, contextWindow } = this.input;
    return {
      message: `the prompt, about ${this.gauge.tokens} tokens, does not fit ${model}'s context window of ${contextWindow} tokens`,
      retryable: true,
    };
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

function reportedFile(call: ToolRequest): string | undefined {
  const file = (call.input as { file?: unknown } | null | undefined)?.file;
  return typeof file === "string" ? file : undefined;
}

// A tool's answer, or why it gave none: a wrong call is told to the model,
// which may correct it, and never ends the attempt.
async function runTool(
  tools: ReadonlyMap<string, ToolDefinition>,
  call: ToolRequest,
  context: ReviewContext,
  outcome: AttemptOutcome,
  uses: ToolUse[],
): Promise<{ output: string; refused?: string }> {
  const tool = tools.get(call.name);
  if (!tool) return { output: `Unknown tool: ${call.name}`, refused: "unknown tool" };
  if (call.malformed) return { output: "Invalid arguments: not JSON", refused: "not JSON" };
  const parsed = tool.inputSchema.safeParse(call.input);
  if (!parsed.success) {
    return {
      output: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
      refused: parsed.error.issues.map((i) => i.path.join(".") || "input").join(", "),
    };
  }
  uses.push({ name: tool.name, input: parsed.data });
  if (tool.name === REVIEW_TOOLS.reportFinding) outcome.findings.push(parsed.data);
  try {
    return { output: await tool.execute(parsed.data, context) };
  } catch (error) {
    return { output: `Tool failed: ${errorMessage(error)}` };
  }
}
