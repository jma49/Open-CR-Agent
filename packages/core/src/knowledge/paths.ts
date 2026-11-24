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

// A learning's paths that name no file of the tree: after a module moves or
// is renamed, reviews no longer give the learning by those paths.
export function unmatchedPaths(
  learnings: readonly { id: string; paths: readonly string[] }[],
  files: readonly string[],
): { id: string; paths: string[] }[] {
  const found = new Map<string, boolean>();
  const matches = (path: string) => {
    let hit = found.get(path);
    if (hit === undefined) {
      hit = files.some(pathMatcher([path]));
      found.set(path, hit);
    }
    return hit;
  };
  return learnings.flatMap((l) => {
    const paths = l.paths.filter((p) => !matches(p));
    return paths.length > 0 ? [{ id: l.id, paths }] : [];
  });
}
