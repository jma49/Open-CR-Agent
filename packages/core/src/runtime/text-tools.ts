import { z } from "zod";
import type { ToolDefinition } from "../contracts.js";
import { data, join, type PromptText, section } from "../review/prompt-text.js";

// Tool calls as text, for a model endpoint that takes no `tools` parameter
// (ADR-0070): the tools are described in the system prompt, the model writes
// each call as a block, and the results come back in the next message. The
// call's form is the one open models are trained on (Hermes, Qwen).

const CALL = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;

const callSchema = z.object({
  name: z.string().min(1),
  // Some models write the arguments as a string of JSON, as the chat
  // completions protocol does.
  arguments: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
});

export interface TextToolCall {
  name: string;
  input: unknown;
  // The block or its arguments were not JSON, so there is no input to check.
  malformed?: true;
}

// What the system prompt says about the tools, after the agent's own.
export function textToolInstructions(tools: readonly ToolDefinition[]): string {
  const listed = tools.map((tool) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(tool.inputSchema) as Record<
      string,
      unknown
    >;
    return `- ${tool.name}: ${tool.description} Arguments: ${JSON.stringify(parameters)}`;
  });
  return `## Calling tools
To call a tool, write a block of exactly this form:
<tool_call>
{"name": "<tool name>", "arguments": {<its arguments as JSON>}}
</tool_call>
You may write several blocks in one answer. Write nothing after the last block: each call's result arrives in the next message, in an <ocra_tool_result> section. A tool is called only by such a block; describing a call in words does nothing.

The tools:
${listed.join("\n")}`;
}

// The calls an answer makes and the text around them.
export function parseTextToolCalls(answer: string): { text: string; calls: TextToolCall[] } {
  const calls = [...answer.matchAll(CALL)].map((block) => toolCall(block[1] ?? ""));
  return { text: answer.replace(CALL, "").trim(), calls };
}

function toolCall(body: string): TextToolCall {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { name: "unknown", input: undefined, malformed: true };
  }
  const parsed = callSchema.safeParse(json);
  if (!parsed.success) return { name: "unknown", input: undefined, malformed: true };
  const { name, arguments: given = {} } = parsed.data;
  if (typeof given !== "string") return { name, input: given };
  try {
    return { name, input: JSON.parse(given || "{}") };
  } catch {
    return { name, input: undefined, malformed: true };
  }
}

// The message that answers a step's calls. A result is data: whatever a
// file holds, it cannot close its section or open another.
export function textToolResults(outputs: readonly { name: string; output: string }[]): PromptText {
  return join(
    outputs.map(({ name, output }) => section("tool_result", data(output), { tool: name })),
  );
}
