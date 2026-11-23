import { describe, expect, it } from "vitest";
import { resolveSettings } from "./settings.js";

describe("depth", () => {
  it("leaves ocra's defaults alone at standard and when unset", () => {
    const { settings, sources } = resolveSettings([
      { source: "file", settings: { depth: "standard" } },
    ]);
    expect({ ...settings, depth: undefined }).toEqual({
      ...resolveSettings([]).settings,
      depth: undefined,
    });
    expect(sources).toEqual({ depth: ["file"] });
  });

  it("fills a quick review's preset where no layer set the key, and records it as the depth's", () => {
    const { settings, sources } = resolveSettings([
      { source: "file", settings: { depth: "quick", reviewers: { docs: { minTier: "lite" } } } },
    ]);
    expect(settings).toMatchObject({
      minInlineSeverity: "warning",
      showPreExisting: false,
      effort: { standard: "low" },
      reviewers: {
        docs: { minTier: "lite" },
        security: { minTier: "full" },
        performance: { enabled: false },
        "agents-md": { enabled: false },
      },
      ultra: false,
    });
    expect(sources).toMatchObject({
      depth: ["file"],
      minInlineSeverity: ["depth"],
      "effort.standard": ["depth"],
      "reviewers.docs": ["file"],
      "reviewers.security": ["depth"],
    });
  });

  it("turns ultra on at deep unless a layer or --no-ultra says otherwise", () => {
    expect(
      resolveSettings([{ source: "account", settings: { depth: "deep" } }]).settings,
    ).toMatchObject({ ultra: true, effort: { standard: "high", top: "high" } });
    const { settings, sources } = resolveSettings([
      { source: "file", settings: { effort: { top: "medium" } } },
      { source: "account", under: true, settings: { depth: "deep" } },
      { source: "flag", settings: { ultra: false } },
    ]);
    expect(settings).toMatchObject({ ultra: false, effort: { standard: "high", top: "medium" } });
    expect(sources).toMatchObject({ ultra: ["flag"], "effort.top": ["file"], depth: ["account"] });
  });

  it("takes the command's --depth over the configuration's", () => {
    const { settings } = resolveSettings([
      { source: "file", settings: { depth: "quick" } },
      { source: "flag", settings: { depth: "deep" } },
    ]);
    expect(settings).toMatchObject({ depth: "deep", ultra: true });
    expect(settings.minInlineSeverity).toBeUndefined();
  });
});
