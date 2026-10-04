import { defineConfig } from "vitest/config";

// Workspace packages export their TypeScript source under this condition, so
// tests run against src/ and need no build (a stale dist/ cannot mislead
// them). Consumers of the published packages never set it and get dist/.
const source = "@open-cr-agent/source";

export default defineConfig({
  // Tests run in Vite's server environment; the rest are Vite's defaults.
  ssr: { resolve: { conditions: [source, "module", "node", "development|production"] } },
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // The end-to-end tests run git in scratch repositories; with every file
    // running in parallel, 5 seconds is not always enough for them.
    testTimeout: 20_000,
  },
});
