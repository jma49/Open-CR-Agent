// The npm ci flags that say whether OpenCode is installed, from the Action's
// opencode input.
/** @param {string | undefined} input */
export function opencodeFlags(input) {
  if (input === undefined || input === "" || input === "true") return [];
  if (input === "false") return ["--omit=optional"];
  throw new Error(`the opencode input must be true or false, not ${JSON.stringify(input)}`);
}
