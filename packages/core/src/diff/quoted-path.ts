import { at } from "../at.js";

const SIMPLE_ESCAPES: ReadonlyMap<string, number> = new Map([
  ["a", 0x07],
  ["b", 0x08],
  ["t", 0x09],
  ["n", 0x0a],
  ["v", 0x0b],
  ["f", 0x0c],
  ["r", 0x0d],
  ['"', 0x22],
  ["\\", 0x5c],
]);

export interface QuotedToken {
  value: string;
  end: number;
}

// Git C-quotes paths with special characters and encodes non-ASCII bytes as
// octal escapes, so the escapes must be decoded as UTF-8 bytes, not code points.
export function readQuotedToken(text: string, start: number): QuotedToken | undefined {
  if (text[start] !== '"') return undefined;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let i = start + 1;
  while (i < text.length) {
    const ch = at(text, i);
    if (ch === '"') {
      return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
    }
    if (ch !== "\\") {
      bytes.push(...encoder.encode(ch));
      i += 1;
      continue;
    }
    const escaped = SIMPLE_ESCAPES.get(text[i + 1] ?? "");
    const octal = /^[0-7]{3}/.exec(text.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 4;
    } else if (escaped !== undefined) {
      bytes.push(escaped);
      i += 2;
    } else {
      return undefined;
    }
  }
  return undefined;
}
