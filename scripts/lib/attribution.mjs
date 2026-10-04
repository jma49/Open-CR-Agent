// The attribution rules CI checks (scripts/attribution.mjs).

const AI_AUTHOR = /^noreply@anthropic\.com$/i;
const CO_AUTHOR = /^co-authored-by:/im;
const FOOTERS = [
  /generated (with|by) \[?claude code/i,
  /claude\.ai\/code\/session_/i,
  /^claude-session:/im,
];

/** @param {string} text */
const footer = (text) => FOOTERS.find((p) => p.test(text));

/**
 * @typedef {object} Commit
 * @property {string} sha
 * @property {string} authorName
 * @property {string} authorEmail
 * @property {string} committerName
 * @property {string} committerEmail
 * @property {string} message
 */

/**
 * Each problem as one line; empty when the pull request is clean.
 * @param {{ commits: Commit[], body?: string }} pullRequest
 */
export function attributionProblems({ commits, body }) {
  /** @type {string[]} */
  const problems = [];
  for (const c of commits) {
    const short = c.sha.slice(0, 7);
    /** @type {[string, string, string][]} */
    const people = [
      ["author", c.authorName, c.authorEmail],
      ["committer", c.committerName, c.committerEmail],
    ];
    for (const [role, name, email] of people) {
      if (AI_AUTHOR.test(email) || /^claude$/i.test(name.trim()))
        problems.push(`${short}: ${role} is an AI tool (${name} <${email}>)`);
    }
    if (CO_AUTHOR.test(c.message)) problems.push(`${short}: has a Co-authored-by trailer`);
    if (footer(c.message)) problems.push(`${short}: message has an AI tool's footer`);
  }
  if (body && footer(body)) problems.push("pull request description has an AI tool's footer");
  return problems;
}
