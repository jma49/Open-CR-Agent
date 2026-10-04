import { createHash } from "node:crypto";
import { OcraError } from "@open-cr-agent/core";
import { repoRuleSchema } from "@open-cr-agent/core/internal";
import { z } from "zod";

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

// What a shared configuration may set: settings, rules and model providers
// (a company gateway, for example), never plugins or a runtime, because it
// is fetched from outside the repository.
export const remoteConfigSchema = z
  .object({
    models: z.record(z.enum(["top", "standard", "light"]), z.unknown()).optional(),
    concurrency: z.unknown().optional(),
    taskTimeoutMinutes: z.unknown().optional(),
    runTimeoutMinutes: z.unknown().optional(),
    verify: z.unknown().optional(),
    judge: z.unknown().optional(),
    maxCostUsd: z.unknown().optional(),
    maxTasks: z.unknown().optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    reviewers: z.record(z.string(), z.unknown()).optional(),
    github: z.record(z.string(), z.unknown()).optional(),
    providers: z.record(z.string(), z.unknown()).optional(),
    rules: z.array(repoRuleSchema).max(500).optional(),
  })
  .strict();
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;

// "https://example.com/ocra.json#sha256=<hex>": the fragment pins the content.
export async function fetchRemoteConfig(
  spec: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RemoteConfig> {
  const [address = "", fragment] = spec.split("#", 2);
  const url = new URL(address);
  if (url.protocol !== "https:")
    throw new OcraError("CONFIG_INVALID", `extends must be an https URL, got ${url.protocol}`);
  const pinned = fragment?.startsWith("sha256=")
    ? fragment.slice("sha256=".length).toLowerCase()
    : undefined;

  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok)
    throw new OcraError("CONFIG_INVALID", `${url.href} answered ${response.status}`);
  const body = await readLimited(response, MAX_BYTES, url.href);
  if (pinned !== undefined) {
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== pinned)
      throw new OcraError("CONFIG_INVALID", `${url.href} does not match its pinned sha256`);
  }
  const parsed = remoteConfigSchema.safeParse(JSON.parse(body));
  if (!parsed.success)
    throw new OcraError(
      "CONFIG_INVALID",
      `${url.href} is invalid: ${z.prettifyError(parsed.error)}`,
    );
  // A provider decides where the code under review goes: unpinned, whoever
  // serves the file could send it to an endpoint of their choosing.
  if (pinned === undefined && Object.keys(parsed.data.providers ?? {}).length > 0) {
    const digest = createHash("sha256").update(body).digest("hex");
    throw new OcraError(
      "CONFIG_INVALID",
      `${url.href} declares providers, which a shared configuration may do only when pinned; check its content, then extend "${address}#sha256=${digest}"`,
    );
  }
  return parsed.data;
}

// Stops reading at the limit instead of buffering whatever the server sends.
async function readLimited(response: Response, limit: number, name: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new OcraError("CONFIG_INVALID", `${name} is larger than 256 KB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The repository's own values win; lists and maps are combined.
export function mergeConfig(
  remote: RemoteConfig,
  local: Record<string, unknown>,
): Record<string, unknown> {
  const { rules: _rules, ...settings } = remote;
  const merged: Record<string, unknown> = { ...settings, ...local };
  for (const key of ["models", "reviewers", "github", "providers"] as const) {
    const a = settings[key];
    const b = local[key];
    if (a !== undefined || b !== undefined)
      merged[key] = { ...(a ?? {}), ...((b as object) ?? {}) };
  }
  for (const key of ["include", "exclude"] as const) {
    const a = settings[key] ?? [];
    const b = (local[key] as string[] | undefined) ?? [];
    if (a.length + b.length > 0) merged[key] = [...a, ...b];
  }
  return merged;
}
