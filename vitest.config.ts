import { defineConfig } from "vitest/config";

// Workspace packages export their TypeScript source under this condition, so
// tests run against src/ and need no build (a stale dist/ cannot mislead
// them). Consumers of the published packages never set it and get dist/.
const source = "@open-cr-agent/source";

export default defineConfig({
  // Tests run in Vite's server environment; the rest are Vite's defaults.
  ssr: { resolve: { conditions: [source, "module", "node", "development|production"] } },
  test: {
    // Git in scratch repositories and real OpenCode servers, with every file
    // running in parallel: 5 seconds is not always enough, and a busy CI
    // runner slows the rest too.
    testTimeout: 20_000,
    // A test file that starts a child process (git, the built CLI, OpenCode)
    // is named *.e2e.test.ts and runs in the e2e project. `npm test`, and so
    // CI, runs both projects; `npm run test:unit` is the fast loop.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
          exclude: ["**/*.e2e.test.ts", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["packages/*/src/**/*.e2e.test.ts"],
        },
      },
    ],
    // Only with --coverage (npm run test:coverage).
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.fakes.ts"],
      reporter: ["text-summary", "json-summary"],
    },
  },
});
