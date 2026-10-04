import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { UsageError } from "../io/usage-error.js";
import { VERSION } from "../version.js";
import { openBrowser } from "./browser.js";
import { credentialsPath } from "./credentials.js";

/** ocra Cloud's address; OCRA_CLOUD_URL names another server. */
export const DEFAULT_CLOUD_URL = "https://app.ocracloud.com";

export type CloudDeps = {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  openBrowser: (url: string) => void;
  credentialsPath: string;
  clientName: string;
};

export function defaultCloudDeps(env: CloudDeps["env"] = process.env): CloudDeps {
  return {
    env,
    fetch: globalThis.fetch,
    now: Date.now,
    sleep: (ms) => sleep(ms),
    openBrowser: (url) => openBrowser(url),
    credentialsPath: credentialsPath(env),
    clientName: `${hostname()} (ocra ${VERSION})`,
  };
}

export function cloudUrl(env: CloudDeps["env"]): string {
  const named = env.OCRA_CLOUD_URL || DEFAULT_CLOUD_URL;
  let url: URL;
  try {
    url = new URL(named);
  } catch {
    throw new UsageError(`OCRA_CLOUD_URL is not a URL: ${named}`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new UsageError(`OCRA_CLOUD_URL must use https: ${url}`);
  }
  return url.origin;
}
