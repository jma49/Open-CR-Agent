// Whether the Action's install did what it should (scripts/check-action-install.mjs).

const SOURCE_REASONS = new Set(["unpublished", "dependencies"]);

/**
 * Building from source is right only while a package at this version is not
 * on npm yet, or when this commit declares other dependencies than the
 * published version; never because an install or a check of what npm
 * serves failed. An install from npm puts ocra under RUNNER_TEMP; one from
 * source does not.
 * @param {{ install: string, main: string, temp: string, source: string }} run
 * @returns {{ error: string } | { note: string } | undefined}
 */
export function installOutcome({ install, main, temp, source }) {
  if (install !== "npm" || main.startsWith(temp)) return undefined;
  if (SOURCE_REASONS.has(source)) return { note: `Built from source: ${source}` };
  return { error: `the Action built from source (${source}) instead of installing from npm` };
}
