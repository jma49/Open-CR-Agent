import type { LineRange, Severity } from "../domain.js";
import type { SarifResult, SarifRule, SarifRun } from "./schema.js";

export interface SarifTool {
  name: string;
  // The reviewer id and finding category the tool's findings carry.
  slug: string;
  version?: string;
}

// A result that could become a finding: on a repository-relative file, with
// lines, a message and a severity. Whether it is on the change is decided
// by the pipeline, which knows the diff.
export interface SarifCandidate {
  file: string;
  lines: LineRange;
  snippet?: string;
  severity: Severity;
  ruleId: string;
  title: string;
  body: string;
}

export interface SarifCandidates {
  tool: SarifTool;
  candidates: SarifCandidate[];
  skipped: { noLocation: number; unsupportedUri: number; noMessage: number };
}

// The same mapping as `--format sarif` writes, so a round trip is identity.
const SEVERITY: Record<string, Severity> = {
  error: "critical",
  warning: "warning",
  note: "suggestion",
  none: "suggestion",
};

export function sarifCandidates(run: SarifRun): SarifCandidates {
  const tool = toolOf(run);
  const rules = run.tool.driver.rules ?? [];
  const byId = new Map(rules.map((r) => [r.id, r]));
  const skipped = { noLocation: 0, unsupportedUri: 0, noMessage: 0 };
  const candidates: SarifCandidate[] = [];
  for (const result of run.results ?? []) {
    const rule = ruleOf(result, rules, byId);
    const ruleId = result.ruleId ?? rule?.id ?? "unknown";
    const text = result.message.text?.trim();
    if (!text) {
      skipped.noMessage += 1;
      continue;
    }
    const physical = result.locations?.[0]?.physicalLocation;
    const uri = physical?.artifactLocation?.uri;
    const region = physical?.region;
    if (uri === undefined || region === undefined) {
      skipped.noLocation += 1;
      continue;
    }
    const file = repositoryPath(uri, physical?.artifactLocation?.uriBaseId);
    if (file === undefined) {
      skipped.unsupportedUri += 1;
      continue;
    }
    const start = region.startLine;
    const end = Math.max(start, region.endLine ?? start);
    const candidate: SarifCandidate = {
      file,
      lines: { start, end },
      severity: SEVERITY[result.level ?? rule?.defaultConfiguration?.level ?? ""] ?? "warning",
      ruleId,
      title: rule?.shortDescription?.text?.trim() || rule?.name || ruleId,
      body: bodyOf(text, ruleId, rule, tool),
    };
    const snippet = region.snippet?.text?.trim();
    if (snippet) candidate.snippet = snippet;
    candidates.push(candidate);
  }
  return { tool, candidates, skipped };
}

function toolOf(run: SarifRun): SarifTool {
  const { name, semanticVersion, version } = run.tool.driver;
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "analyzer";
  const tool: SarifTool = { name, slug };
  const v = semanticVersion ?? version;
  if (v) tool.version = v;
  return tool;
}

function ruleOf(
  result: SarifResult,
  rules: readonly SarifRule[],
  byId: ReadonlyMap<string, SarifRule>,
): SarifRule | undefined {
  if (result.ruleId !== undefined) return byId.get(result.ruleId);
  if (result.ruleIndex !== undefined) return rules[result.ruleIndex];
  return undefined;
}

function bodyOf(text: string, ruleId: string, rule: SarifRule | undefined, tool: SarifTool) {
  const parts = [text];
  const full = rule?.fullDescription?.text?.trim();
  if (full && full !== text) parts.push(full);
  const source = `Reported by ${tool.name}${tool.version ? ` ${tool.version}` : ""}, rule ${ruleId}.`;
  parts.push(rule?.helpUri ? `${source} ${rule.helpUri}` : source);
  return parts.join("\n\n");
}

// Only a path inside the repository can be reviewed: relative, with no
// scheme, drive or parent segment, and with no base other than the source
// root. Anything else is left out and counted.
function repositoryPath(uri: string, base: string | undefined): string | undefined {
  if (base !== undefined && base !== "%SRCROOT%") return undefined;
  let path: string;
  try {
    path = decodeURIComponent(uri);
  } catch {
    return undefined;
  }
  path = path.replaceAll("\\", "/");
  if (path.startsWith("./")) path = path.slice(2);
  if (path === "" || path.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
    return undefined;
  }
  if (path.split("/").some((segment) => segment === "..")) return undefined;
  return path;
}
