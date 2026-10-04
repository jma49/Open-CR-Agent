import { readFileSync, writeFileSync } from "node:fs";
import * as contract from "@open-cr-agent/cloud-contract";
import {
  EFFORT_LEVELS,
  type Effort,
  type Finding,
  MODEL_TIERS,
  type ReviewReport,
  type RiskTier,
  type Verdict,
} from "@open-cr-agent/core";
import {
  AGENT_ROLES,
  RISK_TIERS,
  severitySchema,
  verificationSchema,
} from "@open-cr-agent/core/internal";
import { describe, expect, it } from "vitest";
import { parseAccountPlugins } from "../plugins/account.js";
import { parseAccountSettings } from "./account-settings.js";
import { sharedFindings } from "./findings.js";
import { parseAccountMemory } from "./memory.js";
import { uploadOf } from "./upload.js";

// The fixtures in @open-cr-agent/cloud-contract are what ocra Cloud tests
// its side against (its generated copy, pinned to an engine commit). These
// tests tie them to what this CLI really sends and reads, so a change of
// shape here fails until the fixture changes, and then fails ocra Cloud's
// drift check until it takes the new contract.

const fixture = (name: string) =>
  new URL(`../../../cloud-contract/fixtures/${name}`, import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(fixture(name), "utf8"));

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("the contract's vocabulary", () => {
  it("is the engine's own", () => {
    const verdicts: Same<Verdict, contract.Verdict> = true;
    const tiers: Same<RiskTier, contract.RiskTier> = true;
    const efforts: Same<Effort, contract.Effort> = true;
    expect([verdicts, tiers, efforts]).toEqual([true, true, true]);
    expect(contract.RISK_TIERS).toEqual(RISK_TIERS);
    expect(contract.SEVERITIES).toEqual(severitySchema.options);
    expect(contract.VERIFICATIONS).toEqual(verificationSchema.options);
    expect(contract.EFFORTS).toEqual(EFFORT_LEVELS);
    expect(contract.MODEL_TIERS).toEqual(MODEL_TIERS);
    expect(contract.AGENT_ROLES).toEqual(AGENT_ROLES);
  });
});

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "id",
    fingerprint: "0123456789abcdef",
    reviewer: "security",
    category: "security",
    severity: "critical",
    file: "src/db.ts",
    existingCode: "const q = 'SELECT * FROM t WHERE id = ' + id;",
    title: "SQL built from input",
    body: "The id reaches the query unescaped.",
    evidence: [],
    provenance: { task: "t1" },
    anchor: { method: "hunk", inDiff: true },
    status: "new",
    lineRange: { start: 10, end: 12 },
    verification: "confirmed",
    ...overrides,
  };
}

const { lineRange: _, ...fileLevel } = finding({
  fingerprint: "fedcba9876543210",
  reviewer: "logic",
  category: "correctness",
  severity: "warning",
  file: "src/retry.ts",
  existingCode: "while (true) await attempt();",
  title: "Retry without a limit",
  body: "A failing call is retried forever.",
  suggestion: "Stop after three attempts.",
  verification: "uncertain",
});

const { verification: _v, ...unchecked } = finding({
  fingerprint: "1111222233334444",
  severity: "suggestion",
});

const report = {
  runId: "run-2026-10-04-a1b2",
  tier: "full",
  verdict: "significant_concerns",
  findings: [finding({}), fileLevel, unchecked],
  coverage: [
    { path: "src/db.ts", status: "reviewed" },
    { path: "src/retry.ts", status: "reviewed" },
    { path: "src/huge.ts", status: "unreviewed" },
  ],
  tasks: [
    { reviewer: "security", status: "completed", usage: { costUsd: 0.25 } },
    { reviewer: "logic", status: "completed", usage: { costUsd: 0.125 } },
    { reviewer: "logic", status: "timed_out", usage: { costUsd: 0.0625 } },
  ],
  rereview: {
    fixed: [{ fingerprint: "aaaabbbbccccdddd", title: "t", file: "a.ts", reviewer: "logic" }],
    dismissed: [
      { fingerprint: "eeeeffff00001111", title: "t", file: "b.ts", reviewer: "security" },
    ],
    notReproduced: [],
    notRechecked: [],
    unchanged: [],
  },
  unverifiedCriticals: 0,
  usage: {
    inputTokens: 1200,
    outputTokens: 340,
    reasoningTokens: 0,
    cachedTokens: 0,
    costUsd: 0.4375,
  },
} as unknown as ReviewReport;

describe("the contract's fixtures", () => {
  it("upload.json is what this CLI sends", () => {
    const sent = {
      about: read("upload.json").about,
      ...uploadOf(
        report,
        "github",
        "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
        61_234.4,
      ),
      // Not this CLI's version: the fixture would change with every release.
      ocraVersion: "0.0.0",
      findingList: sharedFindings(report).findings,
    };
    // OCRA_UPDATE_FIXTURES=1 rewrites it; then npm run format.
    if (process.env.OCRA_UPDATE_FIXTURES) {
      writeFileSync(fixture("upload.json"), `${JSON.stringify(sent, null, 2)}\n`);
    }
    expect(sent).toEqual(read("upload.json"));
  });

  it("preferences.json is read whole, with no warning", () => {
    const { answer } = read("preferences.json");
    const { settings, warnings } = parseAccountSettings(answer);
    expect(warnings).toEqual([]);
    expect(Object.keys(settings).sort()).toEqual(
      [
        "version",
        "runtime",
        "models",
        ...Object.keys(answer.agents),
        ...Object.keys(answer.settings).filter((k) => k !== "plugins" && k !== "pluginSettings"),
      ].sort(),
    );
    const warned: string[] = [];
    expect(parseAccountPlugins(answer, (w) => warned.push(w))).toEqual({
      plugins: answer.settings.plugins,
      pluginSettings: answer.settings.pluginSettings,
    });
    expect(warned).toEqual([]);
  });

  it("memory.json is applied whole", () => {
    const { answer } = read("memory.json");
    expect(contract.memoryAnswerSchema.parse(answer)).toEqual(answer);
    const warned: string[] = [];
    expect(parseAccountMemory(answer.entries, (w) => warned.push(w))).toHaveLength(
      answer.entries.length,
    );
    expect(warned).toEqual([]);
  });
});
