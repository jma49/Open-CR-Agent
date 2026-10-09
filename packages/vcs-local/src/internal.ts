// "@open-cr-agent/vcs-local/internal": what the CLI uses beyond the public
// entry. Not a contract: any release may change it.
export { ensureCommits } from "./commits.js";
export { filesChangedSince } from "./history.js";
export { LocalGitAdapter } from "./local-adapter.js";
export { findRepositoryRoot } from "./plugin.js";
