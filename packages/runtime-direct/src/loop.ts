import {
  type AttemptOutcome,
  addUsage,
  emptyUsage,
  errorMessage,
  type ModelPrice,
  REVIEW_TOOLS,
  type ReviewContext,
  type TaskAttempt,
  type ToolDefinition,
  type Usage,
} from "@open-cr-agent/core";
import {
  type CallParams,
  type ChatMessage,
  chat,
  type Endpoint,
  type ToolCall,
  toolSpec,
  withoutEffort,
} from "./openai.js";

export interface LoopInput {
  endpoint: Endpoint;
  model: string;
  price: ModelPrice;
  system: string;
  user: string;
  tools: readonly ToolDefinition[];
  context: ReviewContext;
  // Model requests the attempt may make.
  maxSteps: number;
  // Review agents only: sent once when the agent stops with steps left, no
  // done call and no answer.
  resume?: string;
  // Review agents only: the turn the attempt offers as TaskAttempt.wrapUp.
  wrapUp?: WrapUpTurn;
  timeoutMs: number;
  // Sent with every request, until the endpoint refuses the effort in them.
  params?: CallParams;
  // The endpoint refused the effort; the rest of the attempt goes without it.
  onEffortRefused?: () => void;
  signal: AbortSignal;
  onUsage?: (spent: Usage) => void;
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
  const outcome = await conversation.turn(input.user, input.tools, input.maxSteps, input.resume);
  const { wrapUp } = input;
  if (!wrapUp) return outcome;
  const tools = input.tools.filter((t) => wrapUp.tools.includes(t.name));
  return {
    ...outcome,
    wrapUp: () => conversation.turn(wrapUp.message, tools, outcome.steps + wrapUp.steps),
  };
}

// One attempt's messages and outcome, which a later turn continues under the
// attempt's signal and timeout.
class Conversation {
  private readonly input: LoopInput;
  private readonly timeout: AbortSignal;
  private readonly signal: AbortSignal;
  private readonly messages: ChatMessage[];
  private readonly outcome: AttemptOutcome = {
    findings: [],
    steps: 0,
    toolCalls: [],
    text: "",
    usage: emptyUsage(),
  };
  private readonly texts: string[] = [];
  private params: CallParams;

  constructor(input: LoopInput) {
    this.input = input;
    this.timeout = AbortSignal.timeout(input.timeoutMs);
    this.signal = AbortSignal.any([input.signal, this.timeout]);
    this.messages = [{ role: "system", content: input.system }];
    this.params = input.params ?? {};
  }

  // Runs until the done tool, an answer without tools, or `maxSteps` steps
  // in the whole attempt; returns the attempt's outcome so far.
  async turn(
    message: string,
    offered: readonly ToolDefinition[],
    maxSteps: number,
    resume?: string,
  ): Promise<AttemptOutcome> {
    const { input, messages, outcome, texts } = this;
    const tools = new Map(offered.map((t) => [t.name, t]));
    const specs = offered.map(toolSpec);
    let done = false;
    messages.push({ role: "user", content: message });
    while (outcome.steps < maxSteps) {
      const response = await chat(
        input.endpoint,
        {
          model: input.model,
          messages,
          ...(specs.length > 0 ? { tools: specs } : {}),
          ...this.params,
        },
        input.price,
        this.signal,
      );
      outcome.steps += 1;
      if (response.effortDropped) {
        this.params = withoutEffort(this.params);
        input.onEffortRefused?.();
      }
      if (!response.ok) {
        outcome.error = this.timeout.aborted
          ? { message: `timed out after ${Math.round(input.timeoutMs / 1000)}s`, retryable: true }
          : response.error;
        break;
      }
      outcome.usage = addUsage(outcome.usage, response.usage);
      input.onUsage?.(outcome.usage);
      if (response.content) texts.push(response.content);
      messages.push({
        role: "assistant",
        content: response.content || null,
        ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
      });

      if (response.toolCalls.length === 0) {
        const stoppedEarly = resume && !outcome.resumed && texts.join("").trim() === "";
        if (stoppedEarly && outcome.steps < maxSteps) {
          outcome.resumed = true;
          messages.push({ role: "user", content: resume });
          continue;
        }
        break;
      }
      for (const call of response.toolCalls) {
        outcome.toolCalls.push(call.function.name);
        if (call.function.name === REVIEW_TOOLS.taskDone) done = true;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: await runTool(tools, call, input.context, outcome),
        });
      }
      if (done) break;
    }
    outcome.text = texts.join("\n").trim();
    if (!done && !outcome.error && outcome.steps >= maxSteps) outcome.atStepCap = true;
    else delete outcome.atStepCap;
    return snapshot(outcome);
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
  call: ToolCall,
  context: ReviewContext,
  outcome: AttemptOutcome,
): Promise<string> {
  const tool = tools.get(call.function.name);
  if (!tool) return `Unknown tool: ${call.function.name}`;
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return "Invalid arguments: not JSON";
  }
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
  }
  if (tool.name === REVIEW_TOOLS.reportFinding) outcome.findings.push(parsed.data);
  try {
    return await tool.execute(parsed.data, context);
  } catch (error) {
    return `Tool failed: ${errorMessage(error)}`;
  }
}
