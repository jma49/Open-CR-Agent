import { describe, expect, it } from "vitest";
import { problemsIn } from "./markdown.fakes.js";
import { safeMarkdown } from "./neutralize.js";

// What safeMarkdown's output renders as where it is posted, read by a
// CommonMark parser the way GitHub and GitLab read the comment.
function posted(text: string, startsLine: boolean): string {
  const safe = safeMarkdown(text, { startsLine });
  return startsLine ? safe : `**Suggestion:** ${safe}`;
}

describe("safeMarkdown finds code where CommonMark does", () => {
  // The smallest input of each class on which line-by-line rules once
  // disagreed with the platforms about what is code or a line.
  it.each([
    ["a tag split across lines", "<img\nsrc=x>", false],
    ["a backtick inside a quoted attribute", '<i title="`">@all `x`', false],
    ["an escaped backslash before a backtick", "`x\\\\` @all `", false],
    ["a backslash before the backtick that closes a span", "`x\\` @all `", false],
    ["a bare carriage return", "x\r/merge", false],
    ["an HTML block opened above a fence", "<pre\n```\n@all\n```", true],
    ["a fence closed outside the list item it opened in", "- x\n  ```\n@all\n```", true],
    ["a table cell boundary inside a span", "| `a | @all` |\n| - | - |", true],
    ["a GitLab multiline blockquote around a fence", ">>>\n```\n>>>\n@all\n```", true],
    ["math around a backtick", "$a`b$ @all `", false],
  ])("%s", (_, text, startsLine) => {
    expect(problemsIn(posted(text, startsLine))).toEqual([]);
  });
});

// Pieces of Markdown and HTML syntax, joined at random: the classes above
// and whatever else their combinations make.
const PIECES = [
  ...["`", "``", "```", "~~~", "\\", "    ", "x", "*"],
  ...["<", ">", "pre", "i ", '="', "<!--", "-->"],
  ...["\n", "\r", "\t", " ", "- ", "> ", "1. ", ">>>", "|", "| - |"],
  ...["@a", "/m", "!", "[", "]", "(", ")", ":", "//", "ab:", "www.", "&#64;", "$"],
];

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("safeMarkdown on generated input", () => {
  it("renders no markup, mention, address or command, wherever it is placed", () => {
    const random = seeded(509);
    const pick = () => PIECES[Math.floor(random() * PIECES.length)];
    for (let n = 0; n < 1500; n++) {
      const text = Array.from({ length: 1 + Math.floor(random() * 24) }, pick).join("");
      for (const startsLine of [true, false]) {
        const markdown = posted(text, startsLine);
        expect({ text, startsLine, problems: problemsIn(markdown) }).toEqual({
          text,
          startsLine,
          problems: [],
        });
      }
    }
  });
});
