// CI's check of the Action's install (ci.yml, job action), after
// scripts/action-install.mjs: it installed from npm unless it had a reason
// not to, with an npm cache of its own, and the installed ocra runs and
// finds the OpenCode binary in the installed layout.
//
//   OCRA_INSTALL=npm|source OCRA_MAIN=… OCRA_SOURCE=… node scripts/check-action-install.mjs
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { installOutcome } from "./lib/action-install-check.mjs";

const { OCRA_INSTALL = "", OCRA_MAIN = "", OCRA_SOURCE = "", RUNNER_TEMP = "" } = process.env;
if (!OCRA_MAIN || !RUNNER_TEMP) {
  console.error(
    "usage: OCRA_INSTALL=… OCRA_MAIN=… RUNNER_TEMP=… node scripts/check-action-install.mjs",
  );
  process.exit(2);
}
const outcome = installOutcome({
  install: OCRA_INSTALL,
  main: OCRA_MAIN,
  temp: RUNNER_TEMP,
  source: OCRA_SOURCE,
});
if (outcome && "error" in outcome) {
  console.log(`::error::${outcome.error}`);
  process.exit(1);
}
if (outcome) console.log(outcome.note);
// The install used an npm cache of its own, not ~/.npm.
statSync(join(RUNNER_TEMP, "ocra-npm-cache", "_cacache"));
execFileSync(process.execPath, [OCRA_MAIN, "--version"], { stdio: "inherit" });
const index = createRequire(OCRA_MAIN).resolve("@open-cr-agent/runtime-opencode");
// import() takes a URL: a Windows path would read as the scheme "d:".
const { resolveOpencodeBinary } = await import(
  pathToFileURL(join(dirname(index), "binary.js")).href
);
const binary = resolveOpencodeBinary({});
console.log(binary, execFileSync(binary, ["--version"], { encoding: "utf8" }).trim());
