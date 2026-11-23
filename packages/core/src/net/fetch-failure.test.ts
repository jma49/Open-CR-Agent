import { describe, expect, it } from "vitest";
import { fetchFailure } from "./fetch-failure.js";

const coded = (message: string, code: string, cause?: unknown) =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });

describe("fetchFailure", () => {
  it("is the error's own message when it has no cause", () => {
    expect(fetchFailure(new TypeError("fetch failed"))).toBe("fetch failed");
    expect(fetchFailure("offline")).toBe("offline");
  });

  it("names the network error under fetch failed", () => {
    const cause = coded("getaddrinfo ENOTFOUND llm.corp.test", "ENOTFOUND");
    expect(fetchFailure(new TypeError("fetch failed", { cause }))).toBe(
      "fetch failed: getaddrinfo ENOTFOUND llm.corp.test",
    );
  });

  it("says how to trust a certificate authority Node does not know, however deep the cause", () => {
    const tls = coded("unable to verify the first certificate", "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    const sdk = new Error("Connection error.", {
      cause: new TypeError("fetch failed", { cause: tls }),
    });
    expect(fetchFailure(sdk)).toBe(
      "Connection error: fetch failed: unable to verify the first certificate (trust the server's certificate authority with NODE_EXTRA_CA_CERTS)",
    );
  });

  it("says a repeated message once", () => {
    const cause = new Error("socket hang up", { cause: new Error("socket hang up") });
    expect(fetchFailure(new TypeError("fetch failed", { cause }))).toBe(
      "fetch failed: socket hang up",
    );
  });
});
