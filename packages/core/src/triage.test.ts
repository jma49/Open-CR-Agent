import { describe, expect, it } from "vitest";
import type { FileDiff } from "./domain.js";
import { triage } from "./triage.js";

function diff(path: string, additions: number, deletions = 0): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    kind: "modified",
    isBinary: false,
    additions,
    deletions,
    hunks: [],
    patch: "",
  };
}

describe("triage", () => {
  it("classifies small changes as trivial", () => {
    expect(triage([diff("src/a.ts", 3, 2)])).toBe("trivial");
  });

  it("classifies medium changes as lite", () => {
    expect(triage([diff("src/a.ts", 40), diff("src/b.ts", 30)])).toBe("lite");
  });

  it("classifies large changes as full", () => {
    expect(triage([diff("src/a.ts", 150)])).toBe("full");
  });

  it("forces full review on sensitive paths regardless of size", () => {
    expect(triage([diff("src/auth/session.ts", 1)])).toBe("full");
    expect(triage([diff(".github/workflows/ci.yml", 1)])).toBe("full");
  });

  it("forces full review when a file name or directory names a security concern", () => {
    for (const path of [
      "src/Identity/Extensions.Core/src/PasswordHasher.cs",
      "lib/OAuth2Client.java",
      "pkg/jwt_verify.go",
      "app/models/user_session.rb",
      "server/ACLService.ts",
      "config/secrets.yml",
      "src/security.rs",
    ]) {
      expect(triage([diff(path, 1)]), path).toBe("full");
    }
  });

  it("matches whole words only", () => {
    for (const path of [
      "src/author.ts",
      "db/oracle.sql",
      "src/lexer/tokenizer.ts",
      "src/cryptic.ts",
    ]) {
      expect(triage([diff(path, 1)]), path).toBe("trivial");
    }
  });

  it("forces full review when a renamed file came from a sensitive path", () => {
    expect(triage([{ ...diff("src/users.ts", 1), oldPath: "src/auth.ts", kind: "renamed" }])).toBe(
      "full",
    );
  });

  it("forces full review when too many files change", () => {
    const many = Array.from({ length: 21 }, (_, i) => diff(`src/f${i}.ts`, 0, 0));
    expect(triage(many)).toBe("full");
  });
});
