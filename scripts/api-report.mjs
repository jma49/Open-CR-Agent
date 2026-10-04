#!/usr/bin/env node
// The API reports: etc/<package>.api.md records the public entry ("." in
// exports) of every published package, read from the declarations `tsc -b`
// writes to dist/. A change to a public API changes its report, so review
// sees it, and the check fails until the report is updated.
//
// Usage: node scripts/api-report.mjs [--check]
// Without --check, rewrites the reports (npm run api); with it, fails when a
// report differs from the build (npm run check:api, in CI). Both need a
// build (npm run build, or the type check, which runs tsc -b).
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import apiExtractor from "@microsoft/api-extractor";
import { readWorkspaces } from "./release-lib.mjs";

const { Extractor, ExtractorConfig, ExtractorLogLevel } = apiExtractor;
const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
const reportFolder = join(root, "etc");

mkdirSync(reportFolder, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "ocra-api-"));
const failed = [];
try {
  for (const { dir, json } of readWorkspaces(root).filter((w) => !w.json.private)) {
    const entry = join(dir, "dist", "index.d.ts");
    if (!existsSync(entry)) throw new Error(`${json.name} is not built: run npm run build`);
    const config = ExtractorConfig.prepare({
      configObject: {
        projectFolder: dir,
        newlineKind: "lf",
        mainEntryPointFilePath: entry,
        compiler: { tsconfigFilePath: join(dir, "tsconfig.json") },
        apiReport: {
          enabled: true,
          reportFolder,
          reportTempFolder: temp,
          reportFileName: "<unscopedPackageName>",
          // A type the entry does not export but uses (the zod schema behind
          // an inferred type, say) is recorded too, so its changes show.
          includeForgottenExports: true,
        },
        docModel: { enabled: false },
        dtsRollup: { enabled: false },
        tsdocMetadata: { enabled: false },
        messages: {
          compilerMessageReporting: { default: { logLevel: ExtractorLogLevel.Warning } },
          extractorMessageReporting: {
            default: { logLevel: ExtractorLogLevel.Warning },
            // Release tags (@public, @beta) are not used: what the entry
            // exports is public, and the rest is in ./internal.
            "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
            "ae-undocumented": { logLevel: ExtractorLogLevel.None, addToApiReportFile: false },
            "ae-forgotten-export": { logLevel: ExtractorLogLevel.None, addToApiReportFile: false },
          },
          // The sources use line comments, not TSDoc.
          tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
        },
      },
      configObjectFullPath: undefined,
      packageJsonFullPath: join(dir, "package.json"),
    });
    // Problems in the API itself; whether the report changed is
    // apiReportChanged, which only --check treats as a failure.
    let problems = 0;
    const result = Extractor.invoke(config, {
      localBuild: !check,
      messageCallback: (message) => {
        if (message.messageId === "console-compiler-version-notice")
          message.logLevel = ExtractorLogLevel.None;
        const serious =
          message.logLevel === ExtractorLogLevel.Error ||
          message.logLevel === ExtractorLogLevel.Warning;
        if (serious && !message.messageId.startsWith("console-api-report")) problems += 1;
      },
    });
    if (problems > 0 || (check && result.apiReportChanged)) failed.push(json.name);
    const state = !result.apiReportChanged ? "current" : check ? "out of date" : "updated";
    console.log(
      `${json.name}: API report ${state}${problems > 0 ? `, ${problems} problem(s)` : ""}`,
    );
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
if (failed.length > 0) {
  console.error(
    `\n${failed.join(", ")}: ${check ? "the public API differs from etc/; if the change is intended, run npm run api and commit the report" : "fix the problems above"}`,
  );
  process.exitCode = 1;
}
