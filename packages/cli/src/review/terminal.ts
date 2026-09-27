import { isUnsafeCodePoint } from "@open-cr-agent/core";

// Findings, commit messages and errors can carry text a diff planted; none of
// it may drive the user's terminal. C0 and C1 controls (ANSI and OSC escapes
// start with ESC or a C1 code) except tab and newline, carriage returns, and
// bidirectional overrides ("Trojan Source") become U+FFFD.
export function forTerminal(text: string): string {
  let out = "";
  for (const char of text) out += isUnsafeCodePoint(char.codePointAt(0) ?? 0) ? "�" : char;
  return out;
}
