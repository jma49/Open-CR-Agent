import { globSync, readFileSync } from "node:fs";
import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

// Workspace packages export their TypeScript source under this condition, so
// tests run against src/ and need no build (a stale dist/ cannot mislead
// them). Consumers of the published packages never set it and get dist/.
const source = "@open-cr-agent/source";
const MOCKS_A_MODULE = /\bvi\.(do)?mock\(/;

export default defineConfig({
  // Tests run in Vite's server environment; the rest are Vite's defaults.
  ssr: { resolve: { conditions: [source, "module", "node", "development|production"] } },
  test: {
    // Git in scratch repositories and real OpenCode servers, with every file
    // running in parallel: 5 seconds is not always enough, and a busy CI
    // runner slows the rest too.
    testTimeout: 20_000,
    // Tests within a file run in a new order each run, so one that leans on
    // another's leftovers fails rather than passes by luck.
    sequence: { shuffle: { files: false, tests: true } },
    // A test file that starts a child process (git, the built CLI, OpenCode)
    // is named *.e2e.test.ts (*.e2e.test.mjs in scripts/) and runs in the e2e
    // project (scripts/test-split.test.mjs). `npm test`, and so
    // CI, runs both projects; `npm run test:unit` is the fast loop.
    // Files share their worker's module graph, so a file pays for its imports
    // once per worker rather than once per file. A file that mocks a module
    // (vi.mock) needs a graph of its own: it runs in the project's -isolated
    // twin.
    projects: [
      ...split("unit", ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"], {
        exclude: ["**/*.e2e.test.ts", "**/*.e2e.test.mjs"],
      }),
      ...split("e2e", ["packages/*/src/**/*.e2e.test.ts", "scripts/**/*.e2e.test.mjs"]),
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

function split(
  name: string,
  include: string[],
  { exclude = [] }: { exclude?: string[] } = {},
): TestProjectInlineConfiguration[] {
  const ignored = [...exclude, "**/node_modules/**"];
  const mocking = include
    .flatMap((pattern) => globSync(pattern, { exclude: ignored }))
    .filter((file) => MOCKS_A_MODULE.test(readFileSync(file, "utf8")));
  return [
    { extends: true, test: { name, include, exclude: [...ignored, ...mocking], isolate: false } },
    { extends: true, test: { name: `${name}-isolated`, include: mocking } },
  ];
}
