import { describe, expect, it } from "vitest";
import { SpendLimitReached } from "./agent/spend-limit.js";
import { emptyUsage } from "./agent/usage.js";
import {
  CompletionError,
  errorMessage,
  isOcraError,
  OCRA_ERROR_CODES,
  OcraError,
} from "./errors.js";
import { parseMemory } from "./memory/memory.js";
import { AccessDeniedError } from "./pipeline/context.js";
import { review } from "./pipeline/run.js";
import { PluginError } from "./plugin/registry.js";
import { parseRepoRules } from "./rules/repo-rules.js";
import { parseModel } from "./runtime/models.js";
import { parseSarifLog, SarifError } from "./sarif/schema.js";

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("OcraError", () => {
  it("carries a code, a name and the cause", () => {
    const cause = new Error("underlying");
    const error = new OcraError("VCS_GIT_FAILED", "git failed", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OcraError");
    expect(error.code).toBe("VCS_GIT_FAILED");
    expect(error.message).toBe("git failed");
    expect(error.cause).toBe(cause);
  });

  it("isOcraError narrows, optionally by code", () => {
    const error = new OcraError("INTERNAL", "x");
    expect(isOcraError(error)).toBe(true);
    expect(isOcraError(error, "INTERNAL")).toBe(true);
    expect(isOcraError(error, "CONFIG_INVALID")).toBe(false);
    expect(isOcraError(new Error("x"))).toBe(false);
    expect(isOcraError("x")).toBe(false);
  });

  it("lists each code once", () => {
    expect(new Set(OCRA_ERROR_CODES).size).toBe(OCRA_ERROR_CODES.length);
  });
});

describe("the error subclasses", () => {
  it.each([
    [new CompletionError("failed", emptyUsage()), "CompletionError", "RUNTIME_FAILED"],
    [new SpendLimitReached(2), "SpendLimitReached", "BUDGET_EXHAUSTED"],
    [new AccessDeniedError("no"), "AccessDeniedError", "ACCESS_DENIED"],
    [new SarifError("bad"), "SarifError", "INPUT_INVALID"],
    [new PluginError("bad"), "PluginError", "PLUGIN_INVALID"],
  ] as const)("%s is an OcraError with its own name and code", (error, name, code) => {
    expect(error).toBeInstanceOf(OcraError);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
  });

  it("keeps the cause through a subclass", () => {
    const cause = new Error("quota");
    expect(new CompletionError("failed", emptyUsage(), { cause }).cause).toBe(cause);
    expect(new PluginError("bad", { cause }).cause).toBe(cause);
  });
});

describe("codes on representative throws", () => {
  it("invalid repository files are CONFIG_INVALID and keep the parse error", () => {
    for (const parse of [parseRepoRules, parseMemory]) {
      const error = caught(() => parse("{not json"));
      expect(isOcraError(error, "CONFIG_INVALID")).toBe(true);
      expect((error as OcraError).cause).toBeInstanceOf(SyntaxError);
      expect(
        isOcraError(
          caught(() => parse("{}")),
          "CONFIG_INVALID",
        ),
      ).toBe(true);
    }
  });

  it("a malformed model name is CONFIG_INVALID", () => {
    expect(
      isOcraError(
        caught(() => parseModel("nomodel")),
        "CONFIG_INVALID",
      ),
    ).toBe(true);
  });

  it("an invalid SARIF log is a SarifError", () => {
    expect(caught(() => parseSarifLog("{"))).toBeInstanceOf(SarifError);
  });

  it("review() without reviewers rejects with CONFIG_INVALID", async () => {
    const error = await review({
      vcs: {} as never,
      runtime: {} as never,
      reviewers: [],
    }).catch((e: unknown) => e);
    expect(isOcraError(error, "CONFIG_INVALID")).toBe(true);
    expect(errorMessage(error)).toBe("No reviewer is registered");
  });
});
