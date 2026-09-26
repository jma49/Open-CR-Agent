import { describe, expect, it } from "vitest";
import { parseReviewArgs, UsageError } from "./args.js";

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

  it("returns help", () => {
    expect(parseReviewArgs(["-h"])).toBe("help");
    expect(parseReviewArgs(["--no-repo-config"])).toMatchObject({ ignoreRepoConfig: true });
  });

  it.each([
    [["--commit", "a", "--from", "b"], "--commit cannot be combined with --from or --to"],
    [["--to", "b"], "--to requires --from"],
    [["--format", "xml"], "--format must be text or json, got xml"],
    [["extra"], "Unexpected argument: extra"],
    [["--nope"], "Unknown option '--nope'"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseReviewArgs(argv)).toThrow(UsageError);
    expect(() => parseReviewArgs(argv)).toThrow(message);
  });
});
