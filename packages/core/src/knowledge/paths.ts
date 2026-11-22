import picomatch from "picomatch";

// A learning's paths are read the way .gitignore reads a pattern, since that
// is how people write them: one without a slash matches at any depth, one
// naming a directory matches what is under it, a leading `/` or `./` anchors
// it to the root, and case is ignored. Read literally, `*.sql`, `Dockerfile`
// or `services/billing/` would match nothing below the root, and the learning
// would never be given.
export function pathMatcher(patterns: readonly string[]): (path: string) => boolean {
  return picomatch(patterns.flatMap(expand), { dot: true, nocase: true });
}

function expand(pattern: string): string[] {
  const rooted = /^\.?\//.test(pattern);
  const path = pattern.replace(/^(?:\.?\/)+/, "").replace(/\/+$/, "");
  if (path === "") return ["**"];
  const anywhere = rooted || path.includes("/") ? path : `**/${path}`;
  return anywhere.endsWith("**") ? [anywhere] : [anywhere, `${anywhere}/**`];
}
