import { posix } from "node:path";

const MAP_COMMENT = /\/\/# sourceMappingURL=(\S+)\s*$/m;

/**
 * Published files whose `sourceMappingURL` comment names a map the package
 * does not contain, as "<file> -> <map>". A consumer's bundler warns for each.
 * @param {Map<string, string>} files package path -> content
 * @returns {string[]}
 */
export function danglingSourceMaps(files) {
  const dangling = [];
  for (const [path, content] of files) {
    if (!/\.(c|m)?js$|\.d\.(c|m)?ts$/.test(path)) continue;
    const url = MAP_COMMENT.exec(content)?.[1];
    if (url === undefined || url.startsWith("data:")) continue;
    const map = posix.normalize(posix.join(posix.dirname(path), url));
    if (!files.has(map)) dangling.push(`${path} -> ${map}`);
  }
  return dangling;
}
