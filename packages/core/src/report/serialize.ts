import { isUnsafeCodePoint } from "../unsafe-text.js";

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
