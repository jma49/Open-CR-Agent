#!/usr/bin/env node
// tsc writes dist/ files without the executable bit, so a package's bin
// could not be run directly from a local build (`./packages/eval/dist/main.js`
// or an npx link). npm sets the bit on install; this does it after a build.
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

for (const dir of readdirSync("packages")) {
  const manifest = join("packages", dir, "package.json");
  if (!existsSync(manifest)) continue;
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  const targets = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
  for (const target of targets) {
    const file = join("packages", dir, target);
    if (existsSync(file)) chmodSync(file, 0o755);
  }
}
