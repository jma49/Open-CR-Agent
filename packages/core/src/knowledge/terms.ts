export interface BundleText {
  // The patches with member access written as `.` (MEMBER_ACCESS).
  code: string;
  words: Set<string>;
  // The naming key (namingKey) of every compound identifier.
  names: Set<string>;
  lowercase: () => string;
}

export function bundleText(patches: string): BundleText {
  let lowercase: string | undefined;
  return {
    code: patches.replace(MEMBER_ACCESS, "."),
    words: wordsOf(patches),
    names: namesOf(patches),
    lowercase: () => {
      lowercase ??= patches.toLowerCase();
      return lowercase;
    },
  };
}

// `pool.connect` is `pool?.connect` in TypeScript, `pool->connect` in PHP
// and `Pool::connect` in Rust.
const MEMBER_ACCESS = /\?\.|!\.|->|::/g;

export interface SymbolPattern {
  literal: string;
  name?: string;
}

export function symbolOf(symbol: string): SymbolPattern {
  const literal = symbol.replace(MEMBER_ACCESS, ".");
  const name = WHOLE_IDENTIFIER.test(symbol) ? namingKey(symbol) : undefined;
  return name === undefined ? { literal } : { literal, name };
}

export function symbolMatches(symbol: SymbolPattern, text: BundleText): boolean {
  return (
    containsIdentifier(text.code, symbol.literal) ||
    (symbol.name !== undefined && text.names.has(symbol.name))
  );
}

const IDENTIFIER = /[\p{L}\p{N}_$]+/gu;
const WHOLE_IDENTIFIER = /^[\p{L}\p{N}_$]+$/u;
const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

// A name of two words or more in any convention: `createCharge`,
// `create_charge`, `CreateCharge` and `CREATE_CHARGE` share one key, so a
// learning drawn from a TypeScript client finds the Python service's code.
// One word is left to the literal match: `USER` is not `user`.
function namingKey(identifier: string): string | undefined {
  const parts = identifier
    .split(/[_$]+/)
    .flatMap((part) => part.split(WORD_BOUNDARY))
    .filter((part) => part !== "");
  return parts.length < 2 ? undefined : parts.join("").toLowerCase();
}

function namesOf(text: string): Set<string> {
  const names = new Set<string>();
  for (const identifier of text.match(IDENTIFIER) ?? []) {
    const key = namingKey(identifier);
    if (key !== undefined) names.add(key);
  }
  return names;
}

// A plain search with a check at each end, not a regular expression per
// symbol: compiling one with Unicode look-behinds for each of 500 learnings'
// symbols took seconds.
function containsIdentifier(text: string, symbol: string): boolean {
  if (symbol.length === 0) return false;
  const opensWord = isIdentifierChar(codePointAt(symbol, 0));
  const closesWord = isIdentifierChar(codePointBefore(symbol, symbol.length));
  for (let at = text.indexOf(symbol); at !== -1; at = text.indexOf(symbol, at + 1)) {
    const joinedBefore = opensWord && isIdentifierChar(codePointBefore(text, at));
    const joinedAfter = closesWord && isIdentifierChar(codePointAt(text, at + symbol.length));
    if (!joinedBefore && !joinedAfter) return true;
  }
  return false;
}

function isIdentifierChar(char: string): boolean {
  return char !== "" && IDENTIFIER_CHAR.test(char);
}

function codePointAt(text: string, at: number): string {
  const code = text.codePointAt(at);
  return code === undefined ? "" : String.fromCodePoint(code);
}

function codePointBefore(text: string, end: number): string {
  return [...text.slice(Math.max(0, end - 2), end)].at(-1) ?? "";
}

const TOKEN = /[\p{L}\p{N}]+/gu;
const WORD_BOUNDARY =
  /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u;

// Every token of the text and every part of it split at case changes and
// digits, lowercased, with its singular forms, so the keyword "connection
// pool" matches `ConnectionPool`, `connection_pool` and "connection pools".
function wordsOf(text: string): Set<string> {
  const words = new Set<string>();
  const add = (word: string) => {
    for (const form of forms(word.toLowerCase())) words.add(form);
  };
  for (const token of text.match(TOKEN) ?? []) {
    add(token);
    for (const part of token.split(WORD_BOUNDARY)) add(part);
  }
  return words;
}

// Every form a plural may be the plural of; a wrong one ("caches" to
// "cach") matches nothing, so no rule needs to know English.
function forms(word: string): string[] {
  if (word.length < 5 || !word.endsWith("s") || /(?:ss|us|is)$/.test(word)) return [word];
  const singular = [word, word.slice(0, -1)];
  if (word.endsWith("ies")) singular.push(`${word.slice(0, -3)}y`);
  else if (word.endsWith("es")) singular.push(word.slice(0, -2));
  return singular;
}

const hasWord = (words: Set<string>, word: string) => forms(word).some((f) => words.has(f));

// A keyword matches when each of its tokens is in the text, whole or split
// anywhere at its case changes and digits: `OAuthToken` matches
// `oauth_token` as well as `OAuthToken`. A token in a script written without
// spaces between words, such as Chinese, matches anywhere in the text: in
// "避免连接泄漏" the keyword "连接泄漏" is not a token of its own.
export type Keyword = { whole: string; parts: string[]; unspaced: boolean }[];

const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

export function keywordOf(phrase: string): Keyword {
  return (phrase.match(TOKEN) ?? []).map((token) => ({
    whole: token.toLowerCase(),
    parts: token.split(WORD_BOUNDARY).map((p) => p.toLowerCase()),
    unspaced: UNSPACED_SCRIPT.test(token),
  }));
}

export function keywordMatches(keyword: Keyword, text: BundleText): boolean {
  return keyword.every((token) =>
    token.unspaced ? text.lowercase().includes(token.whole) : segmentable(token.parts, text.words),
  );
}

function segmentable(parts: readonly string[], words: Set<string>): boolean {
  const reachable = [true];
  for (let end = 1; end <= parts.length; end++) {
    reachable[end] = false;
    for (let start = 0; start < end && !reachable[end]; start++) {
      reachable[end] =
        reachable[start] === true && hasWord(words, parts.slice(start, end).join(""));
    }
  }
  return reachable[parts.length] === true;
}

const STOP_WORDS = new Set([
  "after",
  "always",
  "before",
  "check",
  "every",
  "from",
  "into",
  "must",
  "never",
  "only",
  "should",
  "that",
  "their",
  "them",
  "then",
  "there",
  "this",
  "when",
  "where",
  "which",
  "with",
  "without",
]);

export function titleTerms(title: string): string[] {
  return (title.toLowerCase().match(TOKEN) ?? []).filter(
    (w) => w.length >= 4 && !STOP_WORDS.has(w),
  );
}
