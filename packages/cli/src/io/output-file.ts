import { randomBytes } from "node:crypto";
import { lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, relative, sep } from "node:path";
import { OcraError } from "@open-cr-agent/core";

// --output may name a path in a checkout of someone else's change, where a
// committed symbolic link would carry the report to a file outside it.
// Refused: a link at the output path itself, wherever it is, and a link at
// any directory on the way that lives inside the repository. Links outside
// the repository (macOS's /var, a link the user made to the checkout) are
// the user's own and still followed.

/** Throws ACCESS_DENIED when writing to path would go through a refused link. */
export async function refuseLinkedOutput(root: string, path: string): Promise<void> {
  const repository = await realpath(root);
  const { root: top } = parse(path);
  const parts = path.slice(top.length).split(sep).filter(Boolean);
  let parent = top;
  for (const [i, part] of parts.entries()) {
    const current = join(parent, part);
    const info = await lstat(current).catch(() => undefined);
    // Nothing past a missing entry exists; the write itself reports why.
    if (!info) return;
    if (info.isSymbolicLink() && (i === parts.length - 1 || (await isWithin(repository, parent)))) {
      throw new OcraError(
        "ACCESS_DENIED",
        `Refusing to write ${path} through the symbolic link ${current}`,
      );
    }
    parent = current;
  }
}

/**
 * Writes the output file after refuseLinkedOutput. The text goes to a new
 * file next to it, which then replaces the path in one rename: a link put
 * there after the check is replaced rather than written through, and a CI
 * step never reads a half-written report.
 */
export async function writeOutputFile(root: string, path: string, text: string): Promise<void> {
  await refuseLinkedOutput(root, path);
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function isWithin(root: string, dir: string): Promise<boolean> {
  const inside = relative(root, await realpath(dir));
  return inside === "" || !(inside === ".." || inside.startsWith(`..${sep}`) || parse(inside).root);
}
