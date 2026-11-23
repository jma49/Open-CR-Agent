import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  provenanceProblem,
  provenanceProblems,
  RELEASE_WORKFLOW,
  repositoryUrl,
  slsaStatement,
} from "./provenance.mjs";

// @open-cr-agent/cli@0.1.2 as the registry serves it (2026-09-30).
const INTEGRITY =
  "sha512-0WW8VXWgpEYPsGkh0HhsH79u50kPMtT2FRZtz7ORYZucYxF1IYO/fDDdJNAGueb6wnzWyW+nakgiV3tVzFkXVA==";
const DIGEST =
  "d165bc5575a0a4460fb06921d0786c1fbf6ee7490f32d4f615166dcfb391619b9c6311752183bf7c30dd24d006b9e6fac27cd6c96fa76a4822577b55cc591754";
const ATTESTATIONS = "https://registry.npmjs.org/-/npm/v1/attestations/@open-cr-agent%2fcli@0.1.2";
// packages/cli/package.json's repository.url.
const REPOSITORY = "git+https://github.com/jma49/Open-CR-Agent.git";
const cli = {
  name: "@open-cr-agent/cli",
  version: "0.1.2",
  integrity: INTEGRITY,
  repository: REPOSITORY,
};

function statement(workflow = {}, subject = { name: "pkg:npm/%40open-cr-agent/cli@0.1.2" }) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ digest: { sha512: DIGEST }, ...subject }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: "refs/tags/v0.1.2",
            repository: "https://github.com/jma49/Open-CR-Agent",
            path: RELEASE_WORKFLOW,
            ...workflow,
          },
        },
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
}

const envelope = (/** @type {unknown} */ payload) => ({
  predicateType: "https://slsa.dev/provenance/v1",
  bundle: {
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ sig: "MEUC", keyid: "" }],
    },
  },
});

// The registry's answer: npm's publish attestation, then the provenance.
const answer = (payload = statement()) => ({
  attestations: [
    {
      predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
      bundle: { dsseEnvelope: { payload: "e30=", payloadType: "application/vnd.in-toto+json" } },
    },
    envelope(payload),
  ],
});

describe("slsaStatement", () => {
  it("decodes the SLSA provenance among the registry's attestations", () => {
    expect(slsaStatement(answer())).toEqual(statement());
  });

  it("finds none without a provenance attestation or with an unreadable one", () => {
    expect(slsaStatement(undefined)).toBeUndefined();
    expect(slsaStatement({ attestations: [answer().attestations[0]] })).toBeUndefined();
    const garbled = envelope(statement());
    garbled.bundle.dsseEnvelope.payload = "not base64 json";
    expect(slsaStatement({ attestations: [garbled] })).toBeUndefined();
    const other = envelope(statement());
    other.bundle.dsseEnvelope.payloadType = "text/plain";
    expect(slsaStatement({ attestations: [other] })).toBeUndefined();
  });
});

describe("provenanceProblem", () => {
  it("accepts a release built by this repository's release workflow from its tag", () => {
    expect(provenanceProblem(statement(), cli)).toBeUndefined();
    expect(repositoryUrl(REPOSITORY)).toBe("https://github.com/jma49/open-cr-agent");
  });

  it("rejects a package without provenance", () => {
    expect(provenanceProblem(undefined, cli)).toBe(
      "@open-cr-agent/cli@0.1.2 has no SLSA provenance",
    );
  });

  it("rejects provenance for another tarball or another package", () => {
    const other = { ...cli, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` };
    expect(provenanceProblem(statement(), other)).toMatch(/is for another tarball/);
    expect(
      provenanceProblem(statement({}, { name: "pkg:npm/%40open-cr-agent/core@0.1.2" }), cli),
    ).toMatch(/is for another tarball/);
    expect(provenanceProblem(statement(), { ...cli, integrity: "sha1-abc=" })).toMatch(
      /is for another tarball/,
    );
  });

  it("rejects a build from another repository, workflow or ref", () => {
    expect(
      provenanceProblem(
        statement({ repository: "https://github.com/attacker/Open-CR-Agent" }),
        cli,
      ),
    ).toBe(
      "@open-cr-agent/cli@0.1.2 was built from https://github.com/attacker/Open-CR-Agent, not git+https://github.com/jma49/Open-CR-Agent.git",
    );
    expect(provenanceProblem(statement({ path: ".github/workflows/ci.yml" }), cli)).toMatch(
      /built by \.github\/workflows\/ci\.yml, not \.github\/workflows\/release\.yml/,
    );
    expect(provenanceProblem(statement({ ref: "refs/heads/main" }), cli)).toMatch(
      /built from refs\/heads\/main, not refs\/tags\/v0\.1\.2/,
    );
    expect(provenanceProblem(statement({ ref: "refs/tags/v0.1.1" }), cli)).toMatch(
      /not refs\/tags\/v0\.1\.2/,
    );
    expect(provenanceProblem(statement({ repository: undefined }), cli)).toMatch(
      /names no source repository/,
    );
  });
});

describe("provenanceProblems", () => {
  const ok = (/** @type {unknown} */ body) => ({ ok: true, status: 200, json: async () => body });

  it("passes when every package has matching provenance", async () => {
    /** @type {string[]} */
    const asked = [];
    const fetch = async (/** @type {string} */ url) => {
      asked.push(url);
      return ok(answer());
    };
    const problem = await provenanceProblems(
      [
        {
          name: cli.name,
          version: cli.version,
          dist: { integrity: INTEGRITY, attestations: { url: ATTESTATIONS } },
        },
      ],
      { repository: REPOSITORY, fetch },
    );
    expect(problem).toBeUndefined();
    expect(asked).toEqual([ATTESTATIONS]);
  });

  it("rejects 0.1.0, which was published by hand without provenance", async () => {
    // @open-cr-agent/core@0.1.0's dist field, as the registry serves it.
    const dist = {
      integrity:
        "sha512-ZyJuv+nn6fW2IApvc0/+LjtRSerXCFbdK6eEWx0pelyblUqyscWUq//ck5dpgcAuoarPkDe5Ko8pw0v2FsNz8w==",
      tarball: "https://registry.npmjs.org/@open-cr-agent/core/-/core-0.1.0.tgz",
      signatures: [{ sig: "MEUC", keyid: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U" }],
    };
    const fetch = async () => {
      throw new Error("must not be asked");
    };
    expect(
      await provenanceProblems([{ name: "@open-cr-agent/core", version: "0.1.0", dist }], {
        repository: REPOSITORY,
        fetch,
      }),
    ).toBe("@open-cr-agent/core@0.1.0 has no provenance");
  });

  it("never fetches attestations from anywhere but the npm registry", async () => {
    const fetch = async () => {
      throw new Error("must not be asked");
    };
    const dist = { integrity: INTEGRITY, attestations: { url: "https://evil.example/att" } };
    expect(
      await provenanceProblems([{ name: cli.name, version: cli.version, dist }], {
        repository: REPOSITORY,
        fetch,
      }),
    ).toBe("@open-cr-agent/cli@0.1.2 has no provenance");
  });

  it("reports a registry that does not answer", async () => {
    const dist = { integrity: INTEGRITY, attestations: { url: ATTESTATIONS } };
    const packages = [{ name: cli.name, version: cli.version, dist }];
    expect(
      await provenanceProblems(packages, {
        repository: REPOSITORY,
        fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      }),
    ).toBe("could not fetch the provenance of @open-cr-agent/cli@0.1.2 (HTTP 503)");
    expect(
      await provenanceProblems(packages, {
        repository: REPOSITORY,
        fetch: async () => {
          throw new Error("socket hang up");
        },
      }),
    ).toBe("could not fetch the provenance of @open-cr-agent/cli@0.1.2: socket hang up");
  });

  it("reports the first package that fails, in order", async () => {
    const fetch = async () => ok(answer(statement({ ref: "refs/heads/main" })));
    const dist = { integrity: INTEGRITY, attestations: { url: ATTESTATIONS } };
    expect(
      await provenanceProblems(
        [
          { name: "@open-cr-agent/core", version: "0.1.2", dist: {} },
          { name: cli.name, version: cli.version, dist },
        ],
        { repository: REPOSITORY, fetch },
      ),
    ).toBe("@open-cr-agent/core@0.1.2 has no provenance");
  });
});
