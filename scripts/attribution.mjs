// CI's attribution check (AGENTS.md, Commit messages): a pull request's
// commits carry no AI author and no co-author trailers, and neither they nor
// the pull request's description carry an AI tool's footer.
//
//   PR_BODY="..." node scripts/attribution.mjs <base sha> <head sha>
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const AI_AUTHOR = /^noreply@anthropic\.com$/i;
const CO_AUTHOR = /^co-authored-by:/im;
const FOOTERS = [
  /generated (with|by) \[?claude code/i,
  /claude\.ai\/code\/session_/i,
  /^claude-session:/im,
];

const footer = (text) => FOOTERS.find((p) => p.test(text));

/** Each problem as one line; empty when the pull request is clean. */
export function attributionProblems({ commits, body }) {
  const problems = [];
  for (const c of commits) {
    const short = c.sha.slice(0, 7);
    for (const [role, name, email] of [
      ["author", c.authorName, c.authorEmail],
      ["committer", c.committerName, c.committerEmail],
    ]) {
      if (AI_AUTHOR.test(email) || /^claude$/i.test(name.trim()))
        problems.push(`${short}: ${role} is an AI tool (${name} <${email}>)`);
    }
    if (CO_AUTHOR.test(c.message)) problems.push(`${short}: has a Co-authored-by trailer`);
    if (footer(c.message)) problems.push(`${short}: message has an AI tool's footer`);
  }
  if (body && footer(body)) problems.push("pull request description has an AI tool's footer");
  return problems;
}

const SEP = "\u001e";
const FIELD = "\u001f";

export function readCommits(base, head) {
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
      return { sha, authorName, authorEmail, committerName, committerEmail, message };
    });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
}
