import { VERSION } from "../version.js";
import type { CloudDeps } from "./deps.js";

export type TokenAnswer = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  interval?: number;
};

export async function postJson(deps: CloudDeps, url: string, body: unknown, token?: string) {
  const res = await deps.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": `ocra/${VERSION}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

export async function fetchMe(deps: CloudDeps, server: string, token: string) {
  const res = await deps.fetch(`${server}/api/me`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": `ocra/${VERSION}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) return undefined;
  if (!res.ok) throw new Error(`ocra Cloud answered ${res.status}`);
  return (await res.json()) as { login: string };
}
