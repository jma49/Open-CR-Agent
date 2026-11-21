import { homedir } from "node:os";
import { join } from "node:path";

/** ~/.config/ocra ($XDG_CONFIG_HOME/ocra), or %APPDATA%\ocra on Windows: this machine's own. */
export function ocraConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  const base =
    process.platform === "win32"
      ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "ocra");
}

/** $OCRA_CACHE_DIR, else ~/.cache/ocra ($XDG_CACHE_HOME/ocra), or %LOCALAPPDATA%\ocra on Windows: what ocra can rebuild. */
export function ocraCacheDir(env: Readonly<Record<string, string | undefined>>): string {
  if (env.OCRA_CACHE_DIR) return env.OCRA_CACHE_DIR;
  const base =
    process.platform === "win32"
      ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : (env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  return join(base, "ocra");
}
