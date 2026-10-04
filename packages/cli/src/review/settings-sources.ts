import type { ModelTier } from "@open-cr-agent/core";
import { forTerminal } from "../io/terminal.js";
import { ACCOUNT_SCALARS } from "./cloud-settings.js";
import type { CliConfig } from "./config.js";

// Where each setting of a review came from, for --plan (ADR-0027): the
// configuration (its file, a shared one it extends, or OCRA_* variables),
// the ocra Cloud account, both for the keys that combine, or ocra's default.

export type SettingSource = "file" | "account" | "file+account" | "default";

export interface EffectiveSetting {
  key: string;
  // Absent for a default: ocra's own, or the runtime's.
  value?: unknown;
  source: SettingSource;
}

const TIERS: readonly ModelTier[] = ["top", "standard", "light"];

/** file: the configuration before the account's settings; effective: after; filled: what they filled. */
export function effectiveSettings(
  file: CliConfig,
  effective: CliConfig,
  filled: readonly string[],
): EffectiveSetting[] {
  const settings: EffectiveSetting[] = [];
  const add = (key: string, value: unknown, fromFile: boolean) => {
    const fromAccount = filled.includes(key);
    const source: SettingSource =
      fromFile && fromAccount
        ? "file+account"
        : fromAccount
          ? "account"
          : fromFile
            ? "file"
            : "default";
    settings.push(source === "default" ? { key, source } : { key, value, source });
  };
  add("runtime", effective.runtime, file.runtimeSet);
  for (const tier of TIERS) {
    add(`models.${tier}`, effective.models[tier], file.models[tier] !== undefined);
  }
  for (const tier of TIERS) {
    add(`effort.${tier}`, effective.effort[tier], file.effort[tier] !== undefined);
  }
  for (const [id, entry] of Object.entries(effective.reviewers)) {
    add(`reviewers.${id}`, entry, file.reviewers[id] !== undefined);
  }
  for (const [role, entry] of Object.entries(effective.roles)) {
    add(`roles.${role}`, entry, file.roles[role as keyof typeof file.roles] !== undefined);
  }
  for (const key of ACCOUNT_SCALARS) add(key, effective[key], file[key] !== undefined);
  add("include", effective.include, file.include.length > 0);
  add("exclude", effective.exclude, file.exclude.length > 0);
  add(
    "rules",
    effective.rules.map(({ path, source }) => ({ path, source })),
    file.rules.length > 0,
  );
  // A flag rather than a key: listed only when the account turned it on.
  if (filled.includes("ultra")) settings.push({ key: "ultra", value: true, source: "account" });
  return settings;
}

export function renderSettings(
  settings: readonly EffectiveSetting[],
  account: CliConfig["accountSettings"],
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
