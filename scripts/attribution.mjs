// CI's attribution check (AGENTS.md, Commit messages): a pull request's
// commits carry no AI author and no co-author trailers, and neither they nor
// the pull request's description carry an AI tool's footer.
//
//   PR_BODY="..." node scripts/attribution.mjs <base sha> <head sha>
import { execFileSync } from "node:child_process";
import { attributionProblems } from "./lib/attribution.mjs";

/** @typedef {import("./lib/attribution.mjs").Commit} Commit */

const SEP = "\u001e";
const FIELD = "\u001f";

/**
 * @param {string} base
 * @param {string} head
 * @returns {Commit[]}
 */
function readCommits(base, head) {
  const format = ["%H", "%an", "%ae", "%cn", "%ce", "%B"].join(FIELD) + SEP;
  const out = execFileSync("git", ["log", `--format=${format}`, `${base}..${head}`], {
    encoding: "utf8",
  });
  return out
    .split(SEP)
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha, authorName, authorEmail, committerName, committerEmail, message] = r.split(FIELD);
      const fields = { sha, authorName, authorEmail, committerName, committerEmail, message };
      return /** @type {Commit} */ (fields);
    });
}

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error("usage: node scripts/attribution.mjs <base> <head>");
  process.exit(2);
}
const problems = attributionProblems({
  commits: readCommits(base, head),
  body: process.env.PR_BODY ?? "",
});
for (const p of problems) console.error(`::error::${p}`);
if (problems.length > 0) {
  console.error("AGENTS.md: no AI authors, co-author trailers or tool footers.");
  process.exit(1);
}
