// errorMessage() from @open-cr-agent/core, for scripts: some run before a
// build (the Action's install, the release), when core has no dist/ to load.
/** @param {unknown} error */
export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
