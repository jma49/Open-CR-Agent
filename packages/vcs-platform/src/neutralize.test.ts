import { describe, expect, it } from "vitest";
import { safeMarkdown } from "./neutralize.js";

const ZWSP = "\u200b";
const plain = (text: string) => text.replaceAll(ZWSP, "");

describe("safeMarkdown", () => {
  it.each(["/approve", "/merge", "/close", "/label ~bug", "  /unapprove", "\t/assign @me"])(
    "keeps %j from starting a line, where GitLab would run it",
    (command) => {
      const safe = safeMarkdown(`Looks fine.\n${command}\nMore.`);
      expect(safe).not.toMatch(/^[ \t]*\//m);
      expect(plain(safe)).toBe(`Looks fine.\n${command}\nMore.`);
    },
  );

  it("leaves slashes inside a line alone", () => {
    expect(safeMarkdown("Read src/a.ts and a/b")).toBe("Read src/a.ts and a/b");
  });

  it("keeps every @ from mentioning anyone", () => {
    const safe = safeMarkdown("Ask @_alice, @.bob, @all or @here, or mail a@b.example");
    // A mention needs a name right after the @; none has one.
    expect(safe).not.toMatch(/@[^\u200b]/);
    expect(plain(safe)).toBe("Ask @_alice, @.bob, @all or @here, or mail a@b.example");
  });

  it("shows character references as typed, since mentions are found after decoding", () => {
    // GitHub rendered each of the first three as a mention of the user.
    const safe = safeMarkdown("&#64;alice &#x40;all &commat;here &amp; a && b");
    expect(safe).toBe("&\u200b#64;alice &\u200b#x40;all &\u200bcommat;here &\u200bamp; a && b");
  });

  it.each([
    "https://evil.example/fix",
    "HTTP://evil.example",
    "ftp://evil.example",
    "smb://evil.example/share",
    "vscode://evil.example/open",
    "ssh://git@evil.example/r",
  ])("keeps %s from becoming a link on either platform", (address) => {
    const safe = safeMarkdown(`See ${address} and <${address}>.`);
    // GitHub and GitLab both autolink at "://", GitLab for any scheme.
    expect(safe).not.toContain("://");
    expect(plain(safe)).toContain(address);
  });
});

describe("safeMarkdown leaves quoted code as written", () => {
  it("inside inline code spans, and neutralizes the text around them", () => {
    const safe = safeMarkdown("Mail `a@b.example` or open `https://x.example` with @alice");
    expect(safe).toBe("Mail `a@b.example` or open `https://x.example` with @\u200balice");
  });

  it("inside a span opened by a longer backtick string", () => {
    const safe = safeMarkdown("Use `` `@all` `` and ``a@b`` here @me");
    expect(safe).toBe("Use `` `@all` `` and ``a@b`` here @\u200bme");
  });

  it("inside a fenced block that starts a line of the comment", () => {
    const text = [
      "Before @alice",
      "```ts",
      "const url = 'https://x.example'; // @all",
      "/merge",
      "```",
      "After https://y.example",
    ].join("\n");
    const safe = safeMarkdown(text, { startsLine: true });
    expect(safe).toBe(
      [
        "Before @\u200balice",
        "```ts",
        "const url = 'https://x.example'; // @all",
        "/merge",
        "```",
        "After https:\u200b//y.example",
      ].join("\n"),
    );
  });

  it("inside a fenced block indented in a list item, closed by a longer fence", () => {
    const text = "- item\n  ````\n  @all\n  ```\n  `````\n@bob";
    expect(safeMarkdown(text)).toBe("- item\n  ````\n  @all\n  ```\n  `````\n@\u200bbob");
  });

  it("but still breaks ocra's own markers and commands there", () => {
    const safe = safeMarkdown("```\n<!-- ocra:finding 0123456789abcdef -->\n/ocra dismiss\n```", {
      startsLine: true,
    });
    expect(safe).not.toContain("<!--");
    expect(safe).not.toMatch(/\/ocra/);
    expect(plain(safe)).toContain("<!-- ocra:finding");
    expect(safeMarkdown("`<!-- x -->`")).toBe("`<!\u200b-- x -->`");
  });
});

describe("safeMarkdown treats what is not a code span as text", () => {
  it("an unbalanced backtick string: neutralized and escaped", () => {
    expect(safeMarkdown("See `@all and https://x.example")).toBe(
      "See \\`@\u200ball and https:\u200b//x.example",
    );
    expect(safeMarkdown("``a` @all")).toBe("\\`\\`a\\` @\u200ball");
    // The lone backtick finds no partner; the two double ones pair into a span.
    expect(safeMarkdown("`a`` @all ``")).toBe("\\`a`` @all ``");
  });

  it("an escaped backtick, which opens nothing", () => {
    expect(safeMarkdown("\\`@all`")).toBe("\\`@\u200ball\\`");
  });

  it("a span across lines, which GitLab's command extractor reads line by line", () => {
    const safe = safeMarkdown("`a\n/merge @all`");
    expect(safe).toBe("\\`a\n\u200b/merge @\u200ball\\`");
  });

  it("a fence on the first line of text placed after other words", () => {
    const safe = safeMarkdown("```\n@all\n```");
    expect(safe).toBe("\\`\\`\\`\n@\u200ball\n\\`\\`\\`");
  });

  it("a fence that is never closed, or closed by a shorter one", () => {
    expect(safeMarkdown("```\n@all", { startsLine: true })).toBe("\\`\\`\\`\n@\u200ball");
    expect(safeMarkdown("````\n@all\n```", { startsLine: true })).toBe(
      "\\`\\`\\`\\`\n@\u200ball\n\\`\\`\\`",
    );
  });

  it("a ~~~ fence, and an indented block after a line that is not blank", () => {
    expect(safeMarkdown("~~~\n@all\n~~~", { startsLine: true })).toBe("~~~\n@\u200ball\n~~~");
    expect(safeMarkdown("> ```\n    @all", { startsLine: true })).toBe(
      "> \\`\\`\\`\n    @\u200ball",
    );
  });

  it("so that pieces of one line cannot pair backticks across each other", () => {
    // A title with a stray backtick, then a body with a span, on one summary line.
    const line = `**${safeMarkdown("x `")}**: ${safeMarkdown("`@all` z")}`;
    // The title's backtick is escaped, so the body's span is still the only one,
    // and what is outside it was neutralized.
    expect(line).toBe("**x \\`**: `@all` z");
  });
});

describe("safeMarkdown leaves text nothing that binds tighter than a code span", () => {
  it("shows every angle bracket as text, also an incomplete tag", () => {
    expect(safeMarkdown("a < b, <i, \\<b> and `<i>`")).toBe("a &lt; b, &lt;i, \\<b> and `<i>`");
  });

  it("escapes dollar signs, between which both platforms render math", () => {
    expect(safeMarkdown("costs $5, `$HOME` and \\$x")).toBe("costs \\$5, `$HOME` and \\$x");
  });

  it("escapes a backtick after an escaped backslash, which is not escaped itself", () => {
    expect(safeMarkdown("\\\\` @all")).toBe("\\\\\\` @\u200ball");
  });

  it("spaces out a GitLab multiline blockquote fence, which CommonMark reads the same", () => {
    expect(safeMarkdown(">>>\n- >>>> \na >>>", { startsLine: true })).toBe(
      "> > >\n- > > > > \na > > >",
    );
    expect(safeMarkdown(">>> quoted")).toBe(">>> quoted");
  });

  it("ends lines at carriage returns, as CommonMark does", () => {
    expect(safeMarkdown("a\r\n/merge\r/close")).toBe("a\n\u200b/merge\n\u200b/close");
  });

  it("breaks an address whose slashes are escaped, which GitLab links once rendered", () => {
    expect(safeMarkdown("smb:\\/\\/host and www\\.host")).toBe(
      "smb:\u200b\\/\\/host and www\u200b\\.host",
    );
  });
});

describe("safeMarkdown keeps model text from posting what ocra posts only under its own rules", () => {
  it("breaks a GitLab wikilink, which links any target", () => {
    expect(safeMarkdown("[[a|//host/x]] and [[[b]]")).toBe("[​[a|//host/x]] and [​[​[b]]");
  });

  it.each([
    ["a backtick fence", "```suggestion\nx\n```", "```​suggestion\nx\n```"],
    ["a tilde fence", "~~~suggestion:-0+0\nx\n~~~", "~~~​suggestion:-0+0\nx\n~~~"],
    ["an unclosed fence", "~~~Suggestion\nx", "~~~​Suggestion\nx"],
    ["a decoded info string", "```suggesti&#111;n\nx\n```", "```​suggesti&#111;n\nx\n```"],
  ])(
    "breaks the info string of a suggestion in %s, which only ADR-0029's checks may post",
    (_, text, safe) => {
      expect(safeMarkdown(text, { startsLine: true })).toBe(safe);
    },
  );

  it("breaks a suggestion fence past the first line of text placed after other words", () => {
    expect(safeMarkdown("Instead:\n~~~suggestion\nx\n~~~")).toBe("Instead:\n~~~​suggestion\nx\n~~~");
  });
});

describe("safeMarkdown bounds its work", () => {
  it("cuts text at GitHub's comment limit", () => {
    expect(safeMarkdown("a".repeat(70_000))).toBe(`${"a".repeat(65_536)} …(truncated)`);
  });

  it("parses emphasis delimiters in linear time", () => {
    const start = performance.now();
    safeMarkdown("*a".repeat(32_000));
    expect(performance.now() - start).toBeLessThan(3_000);
  });
});

describe("safeMarkdown leaves an indented code block as written", () => {
  it("when it starts a line after a blank one, as code a reviewer quotes", () => {
    const text = "Use:\n\n    p = make_unique<T>(); // @all\n\n    <!-- x -->\nDone @me";
    expect(safeMarkdown(text, { startsLine: true })).toBe(
      "Use:\n\n    p = make_unique<T>(); // @all\n\n    <!​-- x -->\nDone @​me",
    );
  });

  it("but not after other words, where its context is not known", () => {
    expect(safeMarkdown("x\n\n    a<b")).toBe("x\n\n    a&lt;b");
  });
});
