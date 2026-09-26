import { describe, expect, it } from "vitest";
import type { FileChangeKind, FileDiff } from "../domain.js";
import { defaultSelectionPolicy, type SelectionPolicy, selectFiles } from "./select.js";

interface DiffOptions {
  kind?: FileChangeKind;
  isBinary?: boolean;
  oldPath?: string;
  patch?: string;
}

function diff(path: string, options: DiffOptions = {}): FileDiff {
  return {
    oldPath: options.oldPath ?? path,
    newPath: path,
    kind: options.kind ?? "modified",
    isBinary: options.isBinary ?? false,
    additions: 1,
    deletions: 0,
    hunks: [],
    patch: options.patch ?? "@@ -1 +1 @@\n+x",
  };
}

function reasonFor(file: FileDiff, policy: Partial<SelectionPolicy> = {}) {
  const [decision] = selectFiles([file], { ...defaultSelectionPolicy, ...policy });
  return decision?.selected ? "selected" : decision?.reason;
}

describe("selectFiles", () => {
  it.each([
    ["src/app.ts", "selected"],
    ["README.md", "selected"],
    ["Dockerfile", "selected"],
    [".github/workflows/ci.yml", "selected"],
    [".env", "secret"],
    ["config/.env.production", "secret"],
    ["certs/server.pem", "secret"],
    ["deploy/id_rsa", "secret"],
    [".env.example", "selected"],
    ["home/.aws/credentials", "secret"],
    [".git-credentials", "secret"],
    ["infra/prod.tfvars", "secret"],
    [".kube/config", "secret"],
    ["assets/logo.PNG", "extension"],
    ["docs/spec.pdf", "extension"],
    ["assets/icon.svg", "selected"],
    ["package-lock.json", "generated"],
    ["services/api/go.sum", "generated"],
    ["Cargo.lock", "generated"],
    ["vendor/github.com/x/y.go", "generated"],
    ["web/dist/app.min.js", "generated"],
    ["web/dist/app.js.map", "generated"],
    ["api/user.pb.go", "generated"],
    ["src/__snapshots__/a.test.ts.snap", "generated"],
    ["db/migrations/0001_init.sql", "selected"],
    ["app/migrations/vendor/0002.py", "selected"],
  ])("%s → %s", (path, expected) => {
    expect(reasonFor(diff(path))).toBe(expected);
  });

  it("excludes binary files first", () => {
    expect(reasonFor(diff("src/.env", { isBinary: true }))).toBe("binary");
  });

  it("checks the old path of a renamed secret", () => {
    expect(reasonFor(diff("config/settings.txt", { kind: "renamed", oldPath: ".env" }))).toBe(
      "secret",
    );
  });

  it("excludes deleted files", () => {
    expect(reasonFor(diff("src/old.ts", { kind: "deleted" }))).toBe("deleted");
  });

  it("applies user excludes before includes", () => {
    const policy = { include: ["src/**"], exclude: ["src/legacy/**"] };
    expect(reasonFor(diff("src/legacy/a.ts"), policy)).toBe("user_exclude");
  });

  it("lets user includes override extension and generated rules", () => {
    const policy = { include: ["**/*.pb.go", "assets/**"] };
    expect(reasonFor(diff("api/user.pb.go"), policy)).toBe("selected");
    expect(reasonFor(diff("assets/photo.png"), policy)).toBe("selected");
  });

  it("never lets user includes admit secrets", () => {
    expect(reasonFor(diff(".env"), { include: ["**"] })).toBe("secret");
  });

  it("still applies the size ceiling to included files", () => {
    const big = diff("src/huge.ts", { patch: "x".repeat(11) });
    expect(reasonFor(big, { include: ["src/**"], maxPatchChars: 10 })).toBe("too_large");
  });

  it("returns one decision per input in input order", () => {
    const files = [diff("b.ts"), diff("yarn.lock"), diff("a.ts")];
    expect(selectFiles(files).map((d) => d.diff.newPath)).toEqual(["b.ts", "yarn.lock", "a.ts"]);
  });
});
