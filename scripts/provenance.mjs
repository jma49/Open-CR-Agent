// What npm provenance must say before the GitHub Action runs ocra's own
// packages from the registry: built by this repository's release workflow,
// from the tag of the version, for the very tarball npm serves. `npm audit
// signatures` verifies the signatures of the attestations a package has, but
// passes a package that has none, such as one published by hand from a
// stolen npm login; this checks that one exists and what it claims.
import { Buffer } from "node:buffer";
import { errorMessage } from "./error-message.mjs";

/**
 * An in-toto statement as the registry serves it: untrusted, so every field
 * is checked where it is read.
 * @typedef {{
 *   predicateType?: unknown,
 *   subject?: unknown,
 *   predicate?: {
 *     buildDefinition?: {
 *       externalParameters?: { workflow?: { repository?: unknown, path?: unknown, ref?: unknown } },
 *     },
 *   },
 * }} Statement
 * @typedef {{ integrity?: string, attestations?: { url?: unknown } }} Dist
 * @typedef {(url: string, init: { signal: AbortSignal }) =>
 *   Promise<{ ok: boolean, status: number, json(): Promise<unknown> }>} Fetch
 */

export const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
const ATTESTATIONS_URL = /^https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/attestations\//;

// "git+https://github.com/Owner/Repo.git" and "https://github.com/owner/repo"
// name the same repository; GitHub ignores case in both parts.
/** @param {string} url */
export function repositoryUrl(url) {
  return url
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// The SLSA provenance statement in the registry's attestations for one
// package version, or undefined when there is none.
/**
 * @param {{ attestations?: unknown } | null | undefined} answer
 * @returns {Statement | undefined}
 */
export function slsaStatement(answer) {
  const attestations = Array.isArray(answer?.attestations) ? answer.attestations : [];
  const envelope = attestations.find((a) => a?.predicateType === SLSA_PROVENANCE)?.bundle
    ?.dsseEnvelope;
  if (envelope?.payloadType !== "application/vnd.in-toto+json") return undefined;
  if (typeof envelope.payload !== "string") return undefined;
  try {
    return JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

// Why the statement does not show that name@version, the tarball with this
// integrity, was built by `repository`'s release workflow from the tag
// v<version>; undefined when it does.
/**
 * @param {Statement | undefined} statement
 * @param {{ name: string, version: string, integrity: string | undefined, repository: string }} expected
 */
export function provenanceProblem(statement, { name, version, integrity, repository }) {
  const release = `${name}@${version}`;
  if (statement?.predicateType !== SLSA_PROVENANCE) return `${release} has no SLSA provenance`;
  const digest = sha512Hex(integrity);
  const subject = `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  if (!digest || !subjects.some((s) => s?.name === subject && s?.digest?.sha512 === digest)) {
    return `the provenance of ${release} is for another tarball`;
  }
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  const from = (/** @type {unknown} */ value) => (typeof value === "string" ? value : "unknown");
  if (typeof workflow.repository !== "string") return `${release} names no source repository`;
  if (repositoryUrl(workflow.repository) !== repositoryUrl(repository)) {
    return `${release} was built from ${from(workflow.repository)}, not ${repository}`;
  }
  if (workflow.path !== RELEASE_WORKFLOW) {
    return `${release} was built by ${from(workflow.path)}, not ${RELEASE_WORKFLOW}`;
  }
  if (workflow.ref !== `refs/tags/v${version}`) {
    return `${release} was built from ${from(workflow.ref)}, not refs/tags/v${version}`;
  }
  return undefined;
}

// In-toto subjects carry the tarball's SHA-512 in hex; npm's integrity
// field carries it in base64.
/** @param {string | undefined} integrity */
function sha512Hex(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? "");
  return match
    ? Buffer.from(/** @type {string} */ (match[1]), "base64").toString("hex")
    : undefined;
}

// Fetches each package's attestations from the registry, in parallel, and
// returns the first reason one of them cannot be trusted, or undefined.
// `packages` holds each package's name, version and registry `dist` field.
/**
 * @param {ReadonlyArray<{ name: string, version: string, dist: Dist | undefined }>} packages
 * @param {{ repository: string, fetch?: Fetch, timeoutMs?: number }} options
 */
export async function provenanceProblems(
  packages,
  { repository, fetch = globalThis.fetch, timeoutMs = 30_000 },
) {
  const problems = await Promise.all(
    packages.map(async ({ name, version, dist }) => {
      const url = dist?.attestations?.url;
      if (typeof url !== "string" || !ATTESTATIONS_URL.test(url)) {
        return `${name}@${version} has no provenance`;
      }
      /** @type {{ attestations?: unknown } | null | undefined} */
      let answer;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) {
          return `could not fetch the provenance of ${name}@${version} (HTTP ${response.status})`;
        }
        answer = /** @type {typeof answer} */ (await response.json());
      } catch (error) {
        return `could not fetch the provenance of ${name}@${version}: ${errorMessage(error)}`;
      }
      return provenanceProblem(slsaStatement(answer), {
        name,
        version,
        integrity: dist?.integrity,
        repository,
      });
    }),
  );
  return problems.find((problem) => problem !== undefined);
}
