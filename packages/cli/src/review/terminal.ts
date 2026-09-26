function isUnsafe(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

// Findings, commit messages and errors can carry text a diff planted; none of
// it may drive the user's terminal. C0 and C1 controls (ANSI and OSC escapes
// start with ESC or a C1 code) except tab and newline, carriage returns, and
// bidirectional overrides ("Trojan Source") become U+FFFD.
export function forTerminal(text: string): string {
  let out = "";
  for (const char of text) out += isUnsafe(char.codePointAt(0) ?? 0) ? "�" : char;
  return out;
}
