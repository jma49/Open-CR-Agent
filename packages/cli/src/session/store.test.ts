import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSessions, readSessionReport, sessionStart } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessions(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-sessions-"));
  dirs.push(dir);
  return dir;
}

describe("session store", () => {
  it("lists sessions oldest first, without dot files, and none for a missing directory", async () => {
    const dir = sessions();
    for (const id of ["20261002T100000Z-000002", "20261001T100000Z-000001"]) {
      mkdirSync(join(dir, id));
    }
    writeFileSync(join(dir, ".gitignore"), "*\n");
    expect(await listSessions(dir)).toEqual(["20261001T100000Z-000001", "20261002T100000Z-000002"]);
    expect(await listSessions(join(dir, "missing"))).toEqual([]);
  });

  it("reads no report from a session without one or with an unreadable one", async () => {
    const dir = sessions();
    mkdirSync(join(dir, "s1"));
    expect(await readSessionReport(join(dir, "s1"))).toBeUndefined();
    writeFileSync(join(dir, "s1", "report.json"), "{ not json");
    expect(await readSessionReport(join(dir, "s1"))).toBeUndefined();
    writeFileSync(join(dir, "s1", "report.json"), JSON.stringify({ version: 2 }));
    expect(await readSessionReport(join(dir, "s1"))).toBeUndefined();
  });

  it("takes a session's start time from its run id", () => {
    expect(sessionStart("20261002T100000Z-000002")?.toISOString()).toBe("2026-10-02T10:00:00.000Z");
    expect(sessionStart("not-a-session")).toBeUndefined();
  });
});
