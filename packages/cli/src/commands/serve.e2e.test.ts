import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewEvent as WireEvent } from "@open-cr-agent/cloud-contract";
import { afterEach, describe, expect, it } from "vitest";
import { capture, critical, deps, removeRepos, repoWithChange } from "../run.fakes.js";
import { run } from "../run.js";

const homes: string[] = [];
afterEach(() => {
  removeRepos();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function until<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
}

describe("ocra serve", () => {
  it("reviews the working tree on request, streams its events and stops on Ctrl-C", async () => {
    const cwd = repoWithChange();
    const home = mkdtempSync(join(tmpdir(), "ocra-serve-home-"));
    homes.push(home);
    let interrupt = () => {};
    const err = capture();
    const serving = run(
      ["serve"],
      capture(),
      err,
      deps(
        cwd,
        critical,
        {
          env: { XDG_CONFIG_HOME: home, APPDATA: home },
          onInterrupt(handler) {
            interrupt = handler;
            return () => {};
          },
        },
        true,
      ),
    );

    const dir = join(home, "ocra", "serve");
    const file = await until(() =>
      existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".json")) : undefined,
    );
    const { url, token } = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const headers = { authorization: `Bearer ${token}` };
    const started = await fetch(`${url}/runs`, { method: "POST", headers, body: "{}" });
    expect(started.status).toBe(201);
    const { runId } = (await started.json()) as { runId: string };

    const text = await (await fetch(`${url}/runs/${runId}/events`, { headers })).text();
    const events: WireEvent[] = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    expect(events.find((e) => e.kind === "file.finished")?.data).toEqual({
      path: "app.ts",
      status: "reviewed",
    });
    expect(events.filter((e) => e.kind === "finding").at(-1)?.data).toMatchObject({
      file: "app.ts",
      severity: "critical",
      verification: "confirmed",
    });
    expect(events.at(-1)).toMatchObject({ runId, kind: "finished", data: { complete: true } });

    interrupt();
    expect(await serving).toBe(0);
    expect(existsSync(join(dir, file))).toBe(false);
    expect(err.text()).not.toContain(token);
  });
});
