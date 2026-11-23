import { describe, expect, it } from "vitest";
import type { AgentRuntime, CompletionRequest } from "../contracts.js";
import type { ReportedFinding } from "../domain.js";
import type { ReviewEvent } from "../report/report.js";
import { finding, patch, runtime, vcs } from "./run.fakes.js";
import { reviewWithHooks } from "./run.js";

const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 };
const perFile = { groupingMinFiles: 10, maxFilesPerBundle: 1, maxBundleChars: 1_000_000 };
const change = [patch("src/a.ts", "const a = 1;"), patch("src/b.ts", "const b = 2;")].join("\n");
const critical = (file: string, code: string, overrides: Partial<ReportedFinding> = {}) =>
  finding(file, code, { severity: "critical", ...overrides });

interface Script {
  // What the task reviewing each file reports.
  reports: Record<string, ReportedFinding[]>;
  // The task reviewing src/b.ts ends only once src/a.ts was verified.
  gated?: boolean;
  verdict?: "confirmed" | "uncertain" | "refuted";
  judge?: string;
}

function scripted(script: Script) {
  const events: ReviewEvent[] = [];
  let verified = () => {};
  const aVerified = new Promise<void>((resolve) => {
    verified = resolve;
  });
  const requests: CompletionRequest[] = [];
  const rt = runtime(async function* (spec) {
    const file = spec.taskId === "correctness-1" ? "src/a.ts" : "src/b.ts";
    if (script.gated && file === "src/b.ts") await aVerified;
    for (const reported of script.reports[file] ?? []) {
      yield { type: "finding", taskId: spec.taskId, finding: reported };
    }
    yield { type: "done", taskId: spec.taskId };
  });
  const complete: AgentRuntime["complete"] = async (request) => {
    requests.push(request);
    if (request.tier === "top") return { text: script.judge ?? "{}", usage };
    const count = request.user.split("<ocra_finding index=").length - 1;
    const answers = Array.from({ length: count }, (_, index) => ({
      index,
      verdict: script.verdict ?? "confirmed",
      reason: "read the code",
    }));
    return { text: JSON.stringify(answers), usage };
  };
  const onEvent = (event: ReviewEvent) => {
    events.push(event);
    if (event.type === "findings_verified" && event.file === "src/a.ts") verified();
  };
  return { runtime: Object.assign(rt, { complete }), requests, events, onEvent };
}

const run = (s: ReturnType<typeof scripted>, files: Record<string, string> = {}) =>
  reviewWithHooks({
    vcs: vcs(files, change),
    runtime: s.runtime,
    bundling: perFile,
    onEvent: s.onEvent,
  });

const settledIds = (events: readonly ReviewEvent[]) =>
  events.flatMap((e) => (e.type === "findings_verified" ? e.settled : []));
const verifierCalls = (s: ReturnType<typeof scripted>) =>
  s.requests.filter((r) => r.tier === "standard").length;

describe("findings checked while tasks still run", () => {
  it("settles a confirmed critical finding before the other task ends", async () => {
    const s = scripted({
      reports: { "src/a.ts": [critical("src/a.ts", "const a = 1;")] },
      gated: true,
      judge: '{"drop":[{"index":0,"reason":"the description says it is fine"}]}',
    });
    const report = await run(s);
    const kinds = s.events.map((e) =>
      e.type === "task_finished" ? `${e.type}:${e.outcome.taskId}` : e.type,
    );
    expect(kinds.indexOf("findings_verified")).toBeLessThan(
      kinds.indexOf("task_finished:correctness-2"),
    );
    expect(settledIds(s.events)).toEqual(report.findings.map((f) => f.id));
    expect(report.findings[0]).toMatchObject({ severity: "critical", verification: "confirmed" });
    expect(verifierCalls(s)).toBe(1);
  });

  it("settles nothing the judge may still drop or downgrade", async () => {
    const s = scripted({
      reports: {
        "src/a.ts": [finding("src/a.ts", "const a = 1;")],
        "src/b.ts": [critical("src/b.ts", "const b = 2;")],
      },
      verdict: "uncertain",
    });
    const report = await run(s);
    expect(report.findings.map((f) => f.verification)).toEqual(["uncertain", "uncertain"]);
    expect(settledIds(s.events)).toEqual([]);
  });

  it("keeps every settled finding when the judge calls two of them duplicates", async () => {
    const s = scripted({
      reports: {
        "src/a.ts": [critical("src/a.ts", "const a = 1;")],
        "src/b.ts": [critical("src/b.ts", "const b = 2;")],
      },
      judge: '{"duplicates":[[0,1]]}',
    });
    const report = await run(s);
    expect(settledIds(s.events)).toHaveLength(2);
    expect(report.findings.map((f) => f.id).sort()).toEqual(settledIds(s.events).sort());
  });

  it("settles one of two confirmed critical findings on the same lines", async () => {
    const s = scripted({
      reports: {
        "src/a.ts": [
          critical("src/a.ts", "const a = 1;", { title: "first" }),
          critical("src/a.ts", "const a = 1;", { title: "second", category: "security" }),
        ],
      },
      judge: '{"duplicates":[[1,0]]}',
    });
    const report = await run(s, { "src/a.ts": "keep\nconst a = 1;\n" });
    expect(settledIds(s.events)).toHaveLength(1);
    expect(report.findings.map((f) => [f.id, f.title])).toEqual([
      [settledIds(s.events)[0], "first"],
    ]);
  });

  it("verifies a finding once, and one that names a checked file afterwards", async () => {
    const s = scripted({
      reports: {
        "src/a.ts": [critical("src/a.ts", "const a = 1;")],
        "src/b.ts": [finding("src/a.ts", "keep"), finding("src/b.ts", "const b = 2;")],
      },
      gated: true,
    });
    const report = await run(s);
    // src/a.ts while the second task runs, src/b.ts when it ends, and the
    // late finding on src/a.ts in Verify.
    expect(verifierCalls(s)).toBe(3);
    expect(report.findings.map((f) => f.verification)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
    ]);
    const verification = s.events.find((e) => e.type === "verification_finished");
    expect(verification).toMatchObject({ checked: 3, refuted: [] });
  });

  it("drops what the verifier refutes, with the reason", async () => {
    const s = scripted({
      reports: { "src/a.ts": [critical("src/a.ts", "const a = 1;")] },
      verdict: "refuted",
    });
    const report = await run(s);
    expect(report.findings).toEqual([]);
    expect(report.refuted).toMatchObject([{ file: "src/a.ts", reason: "read the code" }]);
    const early = s.events.find((e) => e.type === "findings_verified");
    expect(early).toMatchObject({ kept: [], settled: [] });
    expect(early?.type === "findings_verified" && early.refuted).toHaveLength(1);
  });

  it("does not pay to check a finding memory will take out", async () => {
    const first = await run(
      scripted({ reports: { "src/a.ts": [critical("src/a.ts", "const a = 1;")] } }),
    );
    const s = scripted({ reports: { "src/a.ts": [critical("src/a.ts", "const a = 1;")] } });
    const report = await reviewWithHooks({
      vcs: vcs({}, change),
      runtime: s.runtime,
      bundling: perFile,
      onEvent: s.onEvent,
      accountMemory: [
        {
          fingerprint: first.findings[0]?.fingerprint ?? "",
          file: "src/a.ts",
          title: "t",
          reason: "intended",
        },
      ],
    });
    expect(report.findings).toEqual([]);
    expect(s.requests).toEqual([]);
  });
});
