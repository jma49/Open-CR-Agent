import {
  type AttemptOutcome,
  addUsage,
  emptyUsage,
  errorMessage,
  type ModelPrice,
  REVIEW_TOOLS,
  type ReviewContext,
  type ToolDefinition,
  type Usage,
} from "@open-cr-agent/core";
import { type ChatMessage, chat, type Endpoint, type ToolCall, toolSpec } from "./openai.js";

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
  timeoutMs: number;
  signal: AbortSignal;
  onUsage?: (spent: Usage) => void;
}

// The agent loop: ask the model, run the tools it calls against the review
// context, hand the results back, until it calls task_done, answers without
// tools, or runs out of steps. The model reaches nothing but these tools and
// the endpoint; a finding is what it passes to report_finding, kept as given
// for the pipeline to validate.
export async function runLoop(input: LoopInput): Promise<AttemptOutcome> {
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = AbortSignal.any([input.signal, timeout]);
  const tools = new Map(input.tools.map((t) => [t.name, t]));
  const specs = input.tools.map(toolSpec);
  const messages: ChatMessage[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ];
  const outcome: AttemptOutcome = {
    findings: [],
    steps: 0,
    toolCalls: [],
    text: "",
    usage: emptyUsage(),
  };
  const texts: string[] = [];
  let done = false;

  while (outcome.steps < input.maxSteps) {
    const response = await chat(
      input.endpoint,
      { model: input.model, messages, ...(specs.length > 0 ? { tools: specs } : {}) },
      input.price,
      signal,
    );
    outcome.steps += 1;
    if (!response.ok) {
      outcome.error = timeout.aborted
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
      const stoppedEarly = input.resume && !outcome.resumed && texts.join("").trim() === "";
      if (stoppedEarly && outcome.steps < input.maxSteps) {
        outcome.resumed = true;
        messages.push({ role: "user", content: input.resume as string });
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
  return outcome;
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
