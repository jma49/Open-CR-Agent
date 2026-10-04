import { describe, expect, it } from "vitest";
import { UsageError } from "../../io/usage-error.js";
import { parseReviewArgs } from "./args.js";

describe("parseReviewArgs", () => {
  it("defaults to workspace mode with text output", () => {
    expect(parseReviewArgs([])).toEqual({ target: { mode: "workspace" }, format: "text" });
  });

  it("parses ranges, defaulting --to to HEAD", () => {
    expect(parseReviewArgs(["--from", "main"])).toMatchObject({
      target: { mode: "range", from: "main", to: "HEAD" },
    });
    expect(parseReviewArgs(["--from", "main", "--to", "feat"])).toMatchObject({
      target: { mode: "range", from: "main", to: "feat" },
    });
  });

  it("parses commit mode, format and output", () => {
    expect(parseReviewArgs(["--commit", "abc", "--format", "json", "--output", "r.json"])).toEqual({
      target: { mode: "commit", commit: "abc" },
      format: "json",
      output: "r.json",
    });
  });

  it("accepts sarif as an output format", () => {
    expect(parseReviewArgs(["--format", "sarif", "--output", "ocra.sarif"])).toMatchObject({
      format: "sarif",
      output: "ocra.sarif",
    });
  });

  it("takes a configuration file of the user's own", () => {
    expect(parseReviewArgs(["--config", "ci/ocra.json"])).toMatchObject({
      configFile: "ci/ocra.json",
    });
    expect(parseReviewArgs(["--config", "ci/ocra.json", "--no-repo-config"])).toMatchObject({
      configFile: "ci/ocra.json",
      ignoreRepoConfig: true,
    });
    expect(() => parseReviewArgs(["--config", ""])).toThrow("--config needs a file");
  });

  it("collects --import-sarif files, and refuses them with --plan", () => {
    expect(
      parseReviewArgs(["--import-sarif", "a.sarif", "--import-sarif", "b.sarif"]),
    ).toMatchObject({
      importSarif: ["a.sarif", "b.sarif"],
    });
    expect(parseReviewArgs([])).not.toHaveProperty("importSarif");
    expect(() => parseReviewArgs(["--plan", "--import-sarif", "a.sarif"])).toThrow(
      "--import-sarif is not used by --plan",
    );
  });

  it("returns help", () => {
    expect(parseReviewArgs(["-h"])).toBe("help");
    expect(parseReviewArgs(["--no-repo-config"])).toMatchObject({ ignoreRepoConfig: true });
    expect(parseReviewArgs(["--reviewers", "security, correctness"])).toMatchObject({
      reviewers: ["security", "correctness"],
    });
    expect(() => parseReviewArgs(["--reviewers", " , "])).toThrow(UsageError);
  });

  it.each([
    [["--commit", "a", "--from", "b"], "--commit cannot be combined with --from or --to"],
    [["--to", "b"], "--to requires --from"],
    [["--format", "xml"], "--format must be text, json or sarif, got xml"],
    [["--plan", "--format", "sarif"], "--plan has no findings for --format sarif"],
    [["extra"], "Unexpected argument: extra"],
    [["--nope"], "Unknown option '--nope'"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseReviewArgs(argv)).toThrow(UsageError);
    expect(() => parseReviewArgs(argv)).toThrow(message);
  });
});
