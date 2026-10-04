// Characters a terminal or an editor acts on: C0 controls but tab and
// newline, DEL and C1 controls (ANSI and OSC escapes), line and paragraph
// separators, and bidirectional marks and overrides ("Trojan Source"). One
// definition for every output: terminal text replaces them, JSON escapes them.
export function isUnsafeCodePoint(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

// JSON for files and stdout. JSON.stringify escapes C0 controls but not the
// rest; model and pull request text reaches these files.
export function serializeOutput(value: unknown, indent = 2): string {
  let out = "";
  for (const char of JSON.stringify(value, null, indent)) {
    const code = char.codePointAt(0) ?? 0;
    out +=
      code > 0x1f && isUnsafeCodePoint(code) ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
  return out;
}
