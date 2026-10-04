import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSarifLog, type SarifLog } from "@open-cr-agent/core";
import { ConfigError } from "../../config/cli-config.js";

// A log is untrusted input like everything else that reaches the review; it
// is bounded before it is parsed.
export const MAX_SARIF_BYTES = 20 * 1024 * 1024;

export async function loadSarifLogs(paths: readonly string[], cwd: string): Promise<SarifLog[]> {
  const logs: SarifLog[] = [];
  for (const path of paths) {
    const file = resolve(cwd, path);
    let text: string;
    try {
      const { size } = await stat(file);
      if (size > MAX_SARIF_BYTES) {
        throw new ConfigError(`--import-sarif ${path}: larger than ${MAX_SARIF_BYTES} bytes`);
      }
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(`--import-sarif ${path}: ${(error as Error).message}`);
    }
    try {
      logs.push(parseSarifLog(text));
    } catch (error) {
      throw new ConfigError(`--import-sarif ${path}: ${(error as Error).message}`);
    }
  }
  return logs;
}
