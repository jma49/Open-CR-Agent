import { describe, expect, it } from "vitest";
import { pathMatcher } from "./paths.js";

describe("a learning's paths, read as .gitignore reads them", () => {
  it.each([
    ["*.sql", "db/queries/report.sql", true],
    ["*.sql", "report.sql", true],
    ["Dockerfile", "services/search/Dockerfile", true],
    ["Dockerfile", "Dockerfile.dev", false],
    ["services/billing", "services/billing/src/charge.ts", true],
    ["services/billing/", "services/billing/src/charge.ts", true],
    ["services/billing", "services/billing-v2/src/charge.ts", false],
    ["services/billing", "lib/services/billing/x.ts", false],
    ["./services/**", "services/x.ts", true],
    ["/services/**", "services/x.ts", true],
    ["/Dockerfile", "Dockerfile", true],
    ["/Dockerfile", "services/search/Dockerfile", false],
    ["migrations", "services/orders/migrations/001.sql", true],
    ["services/*/src/db/**", "services/orders/src/db/pool.ts", true],
    ["**/Dockerfile", "apps/admin/dockerfile", true],
    ["apps/site/app/\\[lang\\]/**", "apps/site/app/[lang]/page.tsx", true],
    ["apps/site/app/\\[lang\\]/**", "apps/site/app/l/page.tsx", false],
    ["src/**/*.{ts,tsx}", "src/a/b.tsx", true],
    [".github/workflows/**", ".github/workflows/ci.yml", true],
    ["/", "anything/at/all.ts", true],
  ])("%s matches %s: %s", (pattern, path, expected) => {
    expect(pathMatcher([pattern])(path)).toBe(expected);
  });

  it("takes any of several patterns", () => {
    const matches = pathMatcher(["docs/**", "*.md"]);
    expect(matches("packages/core/README.md")).toBe(true);
    expect(matches("packages/core/src/a.ts")).toBe(false);
  });
});
