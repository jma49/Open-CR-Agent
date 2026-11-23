import type { ReviewDepth } from "@open-cr-agent/cloud-contract";
import type { SettingsLayer } from "./settings.js";

// What each depth sets where no layer sets it itself. Standard is ocra's
// defaults. Quick keeps the correctness reviewer at every tier and security
// where the change is large or sensitive, thinks less, and says only what
// the change itself got wrong, warnings and worse inline; deep is --ultra
// with more thinking.
const PRESETS: Record<ReviewDepth, SettingsLayer["settings"]> = {
  quick: {
    reviewers: {
      security: { minTier: "full" },
      performance: { enabled: false },
      docs: { enabled: false },
      "agents-md": { enabled: false },
    },
    effort: { standard: "low" },
    minInlineSeverity: "warning",
    showPreExisting: false,
  },
  standard: {},
  deep: {
    ultra: true,
    effort: { standard: "high", top: "high" },
  },
};

export const depthPreset = (depth: ReviewDepth | undefined): SettingsLayer["settings"] =>
  PRESETS[depth ?? "standard"];
