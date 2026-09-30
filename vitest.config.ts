import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // The end-to-end tests run git in scratch repositories; with every file
    // running in parallel, 5 seconds is not always enough for them.
    testTimeout: 20_000,
  },
});
