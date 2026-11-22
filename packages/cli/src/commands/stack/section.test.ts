import { describe, expect, it } from "vitest";
import { stackSection, withStackSection } from "./section.js";

const entries = [
  { number: 3, title: "feat: a" },
  { number: 4, title: "feat: <b>" },
];

describe("stackSection", () => {
  it("lists the stack bottom to top with this one in bold and titles neutralized", () => {
    const section = stackSection(entries, 4, "!");
    expect(section).toContain("1. !3 feat: a\n");
    expect(section).toMatch(/2\. \*\*!4 feat: .*b.*\*\* \(this one\)/);
    expect(section).not.toContain("<b>");
  });
});

describe("withStackSection", () => {
  const section = stackSection(entries, 3, "#");

  it("adds the section after the author's text, or alone", () => {
    expect(withStackSection("Why.\n", section)).toBe(`Why.\n\n${section}`);
    expect(withStackSection("", section)).toBe(section);
  });

  it("replaces only what is between the markers", () => {
    const old = withStackSection("Before", stackSection(entries.slice(0, 1), 3, "#"));
    const next = withStackSection(`${old}\n\nAfter`, section);
    expect(next).toBe(`Before\n\n${section}\n\nAfter`);
    expect(withStackSection(next, section)).toBe(next);
  });
});
