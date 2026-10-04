import type { ListedSetting } from "../../config/settings.js";
import { forTerminal } from "../../io/terminal.js";

// Where each setting of a review came from, for --plan (ADR-0027): the
// layers that set it (shared, file, env, account), joined with + for the
// lists that combine, or ocra's default.

export interface EffectiveSetting {
  key: string;
  // Absent for a default: ocra's own, or the runtime's.
  value?: unknown;
  source: string;
}

export interface AccountVersion {
  version: string | null;
}

export function effectiveSettings(listed: readonly ListedSetting[]): EffectiveSetting[] {
  return listed.map(({ key, value, sources }) =>
    sources.length === 0 ? { key, source: "default" } : { key, value, source: sources.join("+") },
  );
}

/** The settings the account set, alone or with other layers. */
export function filledByAccount(listed: readonly ListedSetting[]): string[] {
  return listed.filter((s) => s.sources.includes("account")).map((s) => s.key);
}

export function renderSettings(
  settings: readonly EffectiveSetting[],
  account: AccountVersion | undefined,
): string {
  const lines = [
    "",
    account
      ? `Settings (under your ocra Cloud settings, version ${account.version ?? "none"}):`
      : "Settings:",
  ];
  const set = settings.filter((s) => s.source !== "default");
  const width = Math.max(0, ...set.map((s) => s.key.length));
  for (const s of set) {
    lines.push(`  ${s.key.padEnd(width)}  ${JSON.stringify(s.value)}  (${s.source})`);
  }
  const defaults = settings.filter((s) => s.source === "default").map((s) => s.key);
  if (defaults.length > 0) lines.push(`  default: ${defaults.join(", ")}`);
  return forTerminal(`${lines.join("\n")}\n`);
}

// The account's settings version, for the plan and the provenance.
export function accountOf(account: AccountVersion | undefined): {
  accountSettings?: AccountVersion;
} {
  return account ? { accountSettings: account } : {};
}
