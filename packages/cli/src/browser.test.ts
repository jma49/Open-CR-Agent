import { describe, expect, it } from "vitest";
import { openBrowser, signInPage } from "./browser.js";

const SERVER = "https://cloud.test";

describe("signInPage", () => {
  it("accepts the server's own pages, as the parsed address", () => {
    expect(signInPage(`${SERVER}/device?code=BCDF-GHJK`, SERVER)).toBe(
      `${SERVER}/device?code=BCDF-GHJK`,
    );
    expect(signInPage("https://CLOUD.test/device", SERVER)).toBe(`${SERVER}/device`);
    expect(signInPage("http://localhost:3000/device", "http://localhost:3000")).toBe(
      "http://localhost:3000/device",
    );
    expect(signInPage("http://[::1]:3000/device", "http://[::1]:3000")).toBe(
      "http://[::1]:3000/device",
    );
  });

  it.each([
    "https://elsewhere.test/device",
    "https://cloud.test.elsewhere.test/device",
    "https://cloud.test:8443/device",
    "http://cloud.test/device",
    "file:///etc/hosts",
    "javascript:alert(1)",
    "-https://cloud.test/device",
    "--help",
    "/device",
    "",
  ])("refuses %j", (candidate) => {
    expect(signInPage(candidate, SERVER)).toBeUndefined();
  });

  it("refuses plain http off this machine even when the server uses it", () => {
    expect(signInPage("http://cloud.test/device", "http://cloud.test")).toBeUndefined();
  });
});

describe("openBrowser", () => {
  const record = (platform: NodeJS.Platform) => {
    const calls: [string, string[]][] = [];
    openBrowser(`${SERVER}/device?a=1&b=2`, platform, (command, args) => {
      calls.push([command, args]);
      return { on: () => undefined, unref: () => {} };
    });
    return calls;
  };

  it("hands the address to rundll32 on Windows, never to a command interpreter", () => {
    expect(record("win32")).toEqual([
      ["rundll32", ["url.dll,FileProtocolHandler", `${SERVER}/device?a=1&b=2`]],
    ]);
  });

  it("uses open on macOS and xdg-open elsewhere", () => {
    expect(record("darwin")).toEqual([["open", [`${SERVER}/device?a=1&b=2`]]]);
    expect(record("linux")).toEqual([["xdg-open", [`${SERVER}/device?a=1&b=2`]]]);
  });

  it("treats a missing opener as no error", () => {
    expect(() =>
      openBrowser(SERVER, "linux", () => {
        throw new Error("ENOENT");
      }),
    ).not.toThrow();
  });
});
