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
