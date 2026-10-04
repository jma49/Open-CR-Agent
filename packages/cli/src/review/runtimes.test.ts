import { afterEach, describe, expect, it } from "vitest";
import { capture, critical, deps, removeRepos, repoWithChange } from "../run.fakes.js";
import { run } from "../run.js";
import { BUILTIN_RUNTIMES, loadRuntime } from "./runtimes.js";

afterEach(removeRepos);

const MISSING = "@open-cr-agent/runtime-not-installed";
const importMissing = () => loadRuntime("opencode", MISSING, () => import(MISSING));

describe("BUILTIN_RUNTIMES", () => {
  it("imports the plugin of each built-in runtime by its configured name", async () => {
    expect(Object.keys(BUILTIN_RUNTIMES)).toEqual(["opencode", "direct"]);
    expect((await BUILTIN_RUNTIMES.opencode?.())?.name).toBe("runtime-opencode");
    expect((await BUILTIN_RUNTIMES.direct?.())?.name).toBe("runtime-direct");
  });
});

describe("loadRuntime", () => {
  it("names the missing package and the ways out", async () => {
    await expect(importMissing()).rejects.toMatchObject({ code: "RUNTIME_START_FAILED" });
    await expect(importMissing()).rejects.toThrow(
      new RegExp(
        `The opencode runtime needs ${MISSING}, which is not installed .*npm install ${MISSING}@\\d+\\.\\d+\\.\\d+.*"runtime": "direct"`,
      ),
    );
  });

  it("passes on any other failure unchanged", async () => {
    const inner = Object.assign(new Error("Cannot find package 'undici' imported from x"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    await expect(loadRuntime("opencode", MISSING, () => Promise.reject(inner))).rejects.toBe(inner);
  });
});

describe("ocra review without the configured runtime's package", () => {
  it("stops before any model call with exit code 2 and the reason", async () => {
    const cwd = repoWithChange();
    const err = capture();
    const code = await run(["review"], capture(), err, {
      ...deps(cwd, critical),
      runtimes: { opencode: importMissing },
    });
    expect(code).toBe(2);
    expect(err.text()).toContain(`The opencode runtime needs ${MISSING}, which is not installed`);
  });

  it("still previews the review with --plan", async () => {
    const cwd = repoWithChange();
    const out = capture();
    const code = await run(["review", "--plan"], out, capture(), {
      ...deps(cwd, critical),
      runtimes: { opencode: importMissing },
    });
    expect(code).toBe(0);
    expect(out.text()).toContain("No model was called.");
  });
});
