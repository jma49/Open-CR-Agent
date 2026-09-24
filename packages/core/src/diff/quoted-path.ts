const SIMPLE_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

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
    const ch = text[i] as string;
    if (ch === '"') {
      return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
    }
    if (ch !== "\\") {
      bytes.push(...encoder.encode(ch));
      i += 1;
      continue;
    }
    const next = text[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(text.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 4;
    } else if (next in SIMPLE_ESCAPES) {
      bytes.push(SIMPLE_ESCAPES[next] as number);
      i += 2;
    } else {
      return undefined;
    }
  }
  return undefined;
}
