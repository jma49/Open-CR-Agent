import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOpencodeBinary } from "./binary.js";
import { startOpencodeServer } from "./opencode-server.js";
import { serverEnv } from "./server-env.js";

// A reviewed checkout is hostile, and OpenCode runs plugins and custom tools
// it finds in a project. Two layers keep them out: OpenCode runs in a
// directory of its own, and project configuration is off. Each is checked
// alone, and against a control that shows the planted files do load.
const PLANTED = ["plugins", "plugin", "tools", "tool", "config"] as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function plantCheckout() {
  const root = mkdtempSync(join(tmpdir(), "ocra-checkout-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  const workspace = join(root, "workspace");
  const dirs = { config: join(root, "c"), data: join(root, "d"), state: join(root, "s") };
  for (const dir of [checkout, workspace, ...Object.values(dirs)]) {
    mkdirSync(dir, { recursive: true });
  }
  const marker = (name: string) => join(root, `ran-${name}`);
  const module = (name: string, exported: string) =>
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker(name))}, "x");\n${exported}\n`;
  for (const kind of ["plugins", "plugin"]) {
    mkdirSync(join(checkout, ".opencode", kind), { recursive: true });
    writeFileSync(
      join(checkout, ".opencode", kind, "p.js"),
      module(kind, "export const P = async () => ({});"),
    );
  }
  for (const kind of ["tools", "tool"]) {
    mkdirSync(join(checkout, ".opencode", kind), { recursive: true });
    writeFileSync(
      join(checkout, ".opencode", kind, "t.js"),
      module(kind, 'export default { description: "t", args: {}, execute: async () => "t" };'),
    );
  }
  writeFileSync(join(checkout, "p.js"), module("config", "export const P = async () => ({});"));
  writeFileSync(
    join(checkout, "opencode.json"),
    JSON.stringify({ plugin: [`file://${join(checkout, "p.js")}`] }),
  );
  const ran = () => PLANTED.filter((name) => existsSync(marker(name)));
  return { checkout, workspace, dirs, ran };
}

// Requests that name no directory go to the directory OpenCode runs in; ocra
// names its workspace in every request, and that must not matter either.
async function touch(options: { cwd: string; env: Record<string, string>; workspace: string }) {
  const server = await startOpencodeServer({
    binary: resolveOpencodeBinary(process.env),
    cwd: options.cwd,
    env: options.env,
    config: { share: "disabled", autoupdate: false },
  });
  try {
    const headers = { Authorization: server.authorization };
    const inWorkspace = `?directory=${encodeURIComponent(options.workspace)}`;
    for (const path of [
      "/config",
      "/experimental/tool/ids",
      `/experimental/tool/ids${inWorkspace}`,
    ]) {
      expect((await fetch(`${server.url}${path}`, { headers })).status).toBe(200);
    }
  } finally {
    await server.close();
  }
}

describe("OpenCode and the reviewed checkout", () => {
  it("never runs plugins, tools or configuration planted in the checkout", async () => {
    const withoutFlag = (env: Record<string, string>) => {
      const { OPENCODE_DISABLE_PROJECT_CONFIG: _off, ...rest } = env;
      return rest;
    };

    // Project configuration off, even with OpenCode running in the checkout.
    const flag = plantCheckout();
    await touch({
      cwd: flag.checkout,
      env: serverEnv(process.env, flag.dirs, []),
      workspace: flag.workspace,
    });
    expect(flag.ran()).toEqual([]);

    // OpenCode in its own directory, even with project configuration on.
    const cwd = plantCheckout();
    await touch({
      cwd: cwd.workspace,
      env: withoutFlag(serverEnv(process.env, cwd.dirs, [])),
      workspace: cwd.workspace,
    });
    expect(cwd.ran()).toEqual([]);

    // Control: with neither layer, every planted file runs.
    const control = plantCheckout();
    await touch({
      cwd: control.checkout,
      env: withoutFlag(serverEnv(process.env, control.dirs, [])),
      workspace: control.workspace,
    });
    expect(control.ran()).toEqual([...PLANTED]);
  }, 90_000);
});
