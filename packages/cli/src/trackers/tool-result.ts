import type { LinkedTask, TaskState, TaskTracker } from "@open-cr-agent/core";

// Tool output past this is cut before it is parsed.
export const MAX_RESULT_CHARS = 64_000;

const CLOSED = /^(done|closed|resolved|rejected|completed|已完成|已关闭|已解决|已拒绝)$/i;

export interface ToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}

// A tracker server answers in its own shape: JSON with the task's fields
// (Jira's under `fields`, TAPD's under its kind), or plain text. Known field
// names are read where present; otherwise the text is the task's body.
export function taskFromResult(tracker: TaskTracker, key: string, result: ToolResult): LinkedTask {
  const text = resultText(result).slice(0, MAX_RESULT_CHARS);
  if (result.isError === true)
    throw new Error(text.split("\n")[0]?.slice(0, 300) || "the tool failed");
  const record = unwrap(result.structuredContent ?? parseJson(text));
  if (!record) return { tracker, key, title: key, labels: [], body: text, subtasks: [] };
  const fields = isRecord(record.fields) ? { ...record, ...record.fields } : record;
  const title = firstString(fields, ["summary", "title", "name"]) ?? key;
  const body = firstString(fields, ["description", "body"]) ?? "";
  const state = stateOf(fields.status);
  const labels = Array.isArray(fields.labels)
    ? fields.labels.filter((l): l is string => typeof l === "string")
    : [];
  const url = firstString(fields, ["url", "web_url", "html_url"]);
  return {
    tracker,
    key,
    ...(url && /^https?:\/\//.test(url) ? { url } : {}),
    title,
    ...(state ? { state } : {}),
    labels,
    body,
    subtasks: [],
  };
}

function resultText(result: ToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter(
      (c): c is { type: "text"; text: string } =>
        isRecord(c) && c.type === "text" && typeof c.text === "string",
    )
    .map((c) => c.text)
    .join("\n");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// `{ data: { Story: { ... } } }` reads as the story itself.
function unwrap(value: unknown): Record<string, unknown> | undefined {
  let current = value;
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    const entries = Object.values(current);
    const only = entries.length === 1 ? entries[0] : undefined;
    if (!isRecord(only)) return current;
    current = only;
  }
  return isRecord(current) ? current : undefined;
}

function stateOf(status: unknown): TaskState | undefined {
  const name = typeof status === "string" ? status : isRecord(status) ? status.name : undefined;
  if (typeof name !== "string" || name.length === 0) return undefined;
  return CLOSED.test(name.trim()) ? "closed" : "open";
}

function firstString(
  record: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
