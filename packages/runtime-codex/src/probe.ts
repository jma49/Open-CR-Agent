import { execFile } from "node:child_process";
import { OcraError } from "@open-cr-agent/core";

// The oldest Codex this runtime was tested on: it takes MCP tool approval
// per server and an instructions file in exec.
const MIN_CODEX_VERSION = "0.172.0";
const PROBE_TIMEOUT_MS = 30_000;

export interface Probe {
  binary: string;
  env: Record<string, string>;
}

// The installed Codex: its version, the features it knows, and whether it is
// signed in. `signIn: false` skips the last, for a model provider that
// brings its own key (the scripted endpoint of the end-to-end test).
export async function probeCodex(
  probe: Probe,
  options: { signIn: boolean },
): Promise<{ version: string; features: Set<string> }> {
  const version = await versionOf(probe);
  if (compareVersions(version, MIN_CODEX_VERSION) < 0) {
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `Codex ${version} is older than ${MIN_CODEX_VERSION}, the oldest the codex runtime runs on; update Codex`,
    );
  }
  const [features, signedIn] = await Promise.all([
    run(probe, ["features", "list"]).then((r) => parseFeatures(r.stdout)),
    options.signIn ? run(probe, ["login", "status"]).then((r) => r.code === 0) : true,
  ]);
  if (!signedIn) {
    throw new OcraError(
      "CONFIG_CREDENTIALS_MISSING",
      "Codex is not signed in on this computer: run codex login, then review again",
    );
  }
  return { version, features };
}

async function versionOf(probe: Probe): Promise<string> {
  let result: { code: number; stdout: string };
  try {
    result = await run(probe, ["--version"]);
  } catch (error) {
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `The codex runtime could not start ${probe.binary}: install Codex (npm install -g @openai/codex), or set OCRA_CODEX_BIN to its path`,
      { cause: error },
    );
  }
  const version = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout)?.[0];
  if (result.code !== 0 || version === undefined) {
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `${probe.binary} --version did not name a Codex version`,
    );
  }
  return version;
}

// `codex features list` prints one feature per line: its name, stage and
// whether it is on.
export function parseFeatures(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const name = /^([a-z0-9_]+)\s+\S/.exec(line.trim())?.[1];
    if (name) names.add(name);
  }
  return names;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

// Resolves with the exit code; rejects only when Codex could not be started.
function run(probe: Probe, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      probe.binary,
      args,
      { env: probe.env, timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout });
      },
    );
  });
}
