import { spawn } from "node:child_process";

type Spawner = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; detached: true },
) => { on(event: "error", listener: () => void): unknown; unref(): void };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The sign-in page's address when ocra may open it: an https URL (http only
 * on this machine) on the server in use. Undefined otherwise, and the user
 * opens the printed address themselves.
 */
export function signInPage(candidate: string, server: string): string | undefined {
  let url: URL;
  let origin: string;
  try {
    url = new URL(candidate);
    origin = new URL(server).origin;
  } catch {
    return undefined;
  }
  const scheme =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  return scheme && url.origin === origin ? url.href : undefined;
}

/** Opens an address that signInPage accepted in the default browser. */
export function openBrowser(
  href: string,
  platform: NodeJS.Platform = process.platform,
  spawner: Spawner = spawn,
): void {
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [href]]
      : platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", href]]
        : ["xdg-open", [href]];
  try {
    const child = spawner(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed as well; a missing opener is not an error.
  }
}
