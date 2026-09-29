#!/usr/bin/env node
// Packs every publishable workspace, installs the tarballs into an empty
// project as a user would, and runs the installed ocra: --version, and a
// free --plan review of a scratch repository. Catches missing files,
// undeclared dependencies and broken bin entries before anything is
// published. Needs network access for third-party dependencies.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspaces } from "./release-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (cmd, args, cwd, extra = {}) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...extra,
  });

const packages = readWorkspaces(root).filter((p) => !p.json.private);

const work = mkdtempSync(join(tmpdir(), "ocra-pack-"));
try {
  const tarballs = packages.map((p) => {
    const [info] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], p.dir));
    const files = info.files.map((f) => f.path);
    if (!files.some((f) => f.startsWith("dist/")))
      throw new Error(`${p.json.name} packs no dist/ files`);
    if (files.some((f) => f.endsWith(".test.js") || f.startsWith("src/"))) {
      throw new Error(`${p.json.name} packs sources or tests`);
    }
    console.log(
      `packed ${info.filename} (${files.length} files, ${(info.size / 1024).toFixed(0)} kB)`,
    );
    return join(work, info.filename);
  });

  const app = join(work, "app");
  run("mkdir", ["-p", app], work);
  writeFileSync(join(app, "package.json"), '{ "name": "pack-check", "private": true }\n');
  // A default install, as users run it: the OpenCode platform binary comes as
  // an optional dependency (with --omit=optional, opencode-ai's postinstall fails).
  // `npm run` exports a user-level allow-scripts setting as
  // npm_config_allow_scripts, which npm 11 refuses in a project install.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_config_allow_scripts$/i.test(key)),
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...tarballs], app, {
    env,
  });
  const ocra = join(app, "node_modules", ".bin", "ocra");

  const version = run(ocra, ["--version"], app).trim();
  const expected = JSON.parse(
    readFileSync(join(root, "packages", "cli", "package.json"), "utf8"),
  ).version;
  if (version !== expected)
    throw new Error(`installed ocra reports ${version}, expected ${expected}`);

  // The runtime must find the OpenCode binary in an installed layout, not
  // only inside this monorepo.
  const binaryModule = join(
    app,
    "node_modules",
    "@open-cr-agent",
    "runtime-opencode",
    "dist",
    "binary.js",
  );
  const binary = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { resolveOpencodeBinary } = await import(${JSON.stringify(binaryModule)}); console.log(resolveOpencodeBinary({}));`,
    ],
    app,
  ).trim();
  run(binary, ["--version"], app);
  console.log(`installed runtime finds OpenCode at ${binary.replace(realpathSync(app), ".")}`);

  const repo = join(work, "repo");
  run("mkdir", ["-p", repo], work);
  const git = (...args) => run("git", args, repo);
  git("init", "-q");
  git(
    "-c",
    "user.email=p@example.com",
    "-c",
    "user.name=P",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  writeFileSync(join(repo, "app.ts"), "export const retries = -1;\n");
  const plan = run(ocra, ["review", "--plan"], repo);
  if (!plan.includes("Review tasks: 1")) throw new Error(`unexpected --plan output:\n${plan}`);
  console.log(`installed ocra ${version} runs: --version and review --plan`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
