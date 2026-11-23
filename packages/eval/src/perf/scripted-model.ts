import { createServer, type ServerResponse } from "node:http";

type ModelCallKind = "review" | "plan" | "grouping" | "verify" | "judge" | "other";

export interface ModelCalls {
  requests: number;
  // Four characters per token, as `ocra review --plan` counts.
  inputTokens: number;
  // Of those, the tokens that repeat the start of an earlier request: what
  // a provider's prompt cache could have served.
  repeatedTokens: number;
  largestRequestTokens: number;
}

export interface ScriptedModel {
  url: string;
  calls(): Record<ModelCallKind, ModelCalls>;
  close(): Promise<void>;
}

interface ChatRequest {
  model: string;
  stream?: boolean;
  messages: { role: string; content?: unknown; tool_calls?: { function: { name: string } }[] }[];
  tools?: { function: { name: string } }[];
}

interface Reply {
  content?: string;
  toolCalls?: { name: string; args: unknown }[];
}

const CHARS_PER_TOKEN = 4;
const FILES_READ = 3;
const SEARCHES = 3;

/**
 * An OpenAI-compatible endpoint on this machine that answers as a reviewer
 * with fixed habits would, after `latencyMs`: it reads the first files of
 * its bundle, searches for the functions the added lines call, reads a diff,
 * reports one finding on an added line and says it is done. It groups files
 * by directory, confirms every finding and judges without changing any. The
 * same change gets the same requests, so their count and size measure ocra.
 */
export async function scriptedModel(latencyMs = 0): Promise<ScriptedModel> {
  const seen: { kind: ModelCallKind; prompt: string; repeated: number }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const request = JSON.parse(body) as ChatRequest;
      const { kind, reply } = answer(request);
      const prompt = promptText(request);
      seen.push({ kind, prompt, repeated: longestSharedStart(prompt, seen) });
      const send = () => respond(res, request, reply, prompt.length);
      if (latencyMs > 0) setTimeout(send, latencyMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls: () => summarize(seen),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function answer(request: ChatRequest): { kind: ModelCallKind; reply: Reply } {
  const text = (role: string) =>
    request.messages
      .filter((m) => m.role === role && typeof m.content === "string")
      .map((m) => m.content as string)
      .join("\n");
  const system = text("system");
  const user = text("user");
  // Asked as the reviewer, with its tools (ADR-0066), so it is told apart
  // by how the prompt ends.
  if (user.trimEnd().endsWith("at most 150 words.")) {
    return { kind: "plan", reply: { content: "- Check the added lines." } };
  }
  if (request.tools?.some((t) => t.function.name.endsWith("report_finding"))) {
    return { kind: "review", reply: reviewStep(request, user) };
  }
  if (system.includes("judge of a multi-agent code review")) {
    const verdict = { duplicates: [], drop: [], severity: [], summary: "Scripted summary." };
    return { kind: "judge", reply: { content: JSON.stringify(verdict) } };
  }
  const titles = [...user.matchAll(/^Title: /gm)];
  if (titles.length > 0) {
    const checked = titles.map((_, index) => ({ index, verdict: "confirmed", reason: "Shown." }));
    return { kind: "verify", reply: { content: JSON.stringify(checked) } };
  }
  const listed = [...user.matchAll(/^\[(\d+)\] \S+ (\S+)/gm)];
  if (listed.length > 0) {
    const groups = new Map<string, number[]>();
    for (const [, index = "", path = ""] of listed) {
      const directory = path.split("/").slice(0, -1).join("/") || ".";
      groups.set(directory, [...(groups.get(directory) ?? []), Number(index)]);
    }
    const grouped = [...groups].map(([label, files]) => ({ label, files }));
    return { kind: "grouping", reply: { content: JSON.stringify(grouped) } };
  }
  return { kind: "other", reply: { content: "Nothing to add." } };
}

// The reviewer's next step, from how many it has taken.
function reviewStep(request: ChatRequest, user: string): Reply {
  const taken = request.messages.filter((m) => m.role === "assistant");
  const called = (tool: string) =>
    taken.some((m) => m.tool_calls?.some((c) => c.function.name.endsWith(tool)));
  // OpenCode asks once more after the done tool; the direct runtime does not.
  if (called("task_done")) return { content: "Reviewed." };
  const blocks = user
    .slice(Math.max(0, user.indexOf("<ocra_review_files>\n<ocra_file")))
    .split(/^<ocra_file path="/m)
    .slice(1)
    .map((block) => ({ path: block.slice(0, block.indexOf('"')), diff: block }));
  const files = blocks.map((block) => block.path);
  const added = blocks.flatMap(({ path, diff }) => {
    const line = /^\+(.{24,120})$/m.exec(diff);
    return line ? [{ file: path, existingCode: line[1] }] : [];
  })[0];
  const names = blocks.flatMap(({ diff }) =>
    [...diff.matchAll(/^\+.*?\b([A-Za-z_]\w{7,30})\(/gm)].map((m) => m[1] as string),
  );
  const steps: Reply["toolCalls"][] = [
    files.slice(0, FILES_READ).map((path) => ({ name: "read_file", args: { path } })),
    [...new Set(names)]
      .slice(0, SEARCHES)
      .map((literal) => ({ name: "code_search", args: { literal } })),
    files.slice(0, 1).map((path) => ({ name: "read_diff", args: { path } })),
    added
      ? [
          {
            name: "report_finding",
            args: {
              ...added,
              severity: "warning",
              title: "Scripted finding",
              body: "The scripted reviewer reports the first added line it reads.",
            },
          },
        ]
      : [],
  ];
  const next = steps.filter((calls) => calls && calls.length > 0)[taken.length];
  return { toolCalls: next ?? [{ name: "task_done", args: {} }] };
}

function promptText(request: ChatRequest): string {
  const messages = request.messages.map((m) =>
    typeof m.content === "string" ? `${m.role}\n${m.content}` : JSON.stringify(m),
  );
  return [JSON.stringify(request.tools ?? []), ...messages].join("\n");
}

function longestSharedStart(prompt: string, earlier: readonly { prompt: string }[]): number {
  let longest = 0;
  for (const { prompt: other } of earlier) {
    const limit = Math.min(prompt.length, other.length);
    let shared = 0;
    while (shared < limit && prompt.charCodeAt(shared) === other.charCodeAt(shared)) shared += 1;
    longest = Math.max(longest, shared);
  }
  return longest;
}

function summarize(
  seen: readonly { kind: ModelCallKind; prompt: string; repeated: number }[],
): Record<ModelCallKind, ModelCalls> {
  const empty = (): ModelCalls => ({
    requests: 0,
    inputTokens: 0,
    repeatedTokens: 0,
    largestRequestTokens: 0,
  });
  const calls = {
    review: empty(),
    plan: empty(),
    grouping: empty(),
    verify: empty(),
    judge: empty(),
    other: empty(),
  };
  const tokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
  for (const { kind, prompt, repeated } of seen) {
    const of = calls[kind];
    of.requests += 1;
    of.inputTokens += tokens(prompt.length);
    of.repeatedTokens += tokens(repeated);
    of.largestRequestTokens = Math.max(of.largestRequestTokens, tokens(prompt.length));
  }
  return calls;
}

function respond(res: ServerResponse, request: ChatRequest, reply: Reply, promptChars: number) {
  const offered = request.tools?.map((t) => t.function.name) ?? [];
  const toolCalls = reply.toolCalls?.map((call, i) => ({
    id: `call-${promptChars}-${i}`,
    type: "function",
    function: {
      // A runtime may prefix the review tools' names.
      name: offered.find((n) => n === call.name || n.endsWith(`_${call.name}`)) ?? call.name,
      arguments: JSON.stringify(call.args),
    },
  }));
  const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: 50,
    total_tokens: promptTokens + 50,
  };
  const finish = toolCalls ? "tool_calls" : "stop";
  const identity = { id: "scripted", created: 1, model: request.model };
  if (!request.stream) {
    const message = {
      role: "assistant",
      content: reply.content ?? null,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ...identity,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      }),
    );
    return;
  }
  const chunk = (delta: object, finishReason: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ ...identity, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content: reply.content ?? "" }, null));
  if (toolCalls) {
    res.write(chunk({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }, null));
  }
  res.write(chunk({}, finish, { usage }));
  res.end("data: [DONE]\n\n");
}
