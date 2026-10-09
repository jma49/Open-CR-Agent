import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, relative, sep } from "node:path";
import { OcraError } from "@open-cr-agent/core";

// --output may name a path in a checkout of someone else's change, where a
// committed symbolic link would carry the report to a file outside it.
// Refused: a link at the output path itself, wherever it is, and a link at
// any directory on the way that lives inside the repository. Links outside
// the repository (macOS's /var, a link the user made to the checkout) are
// the user's own and still followed. An existing output must be a regular
// file.

/** Throws ACCESS_DENIED when writing to path would go through a refused link or replace no regular file. */
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
    // The report replaces the file in a rename (writeOutputFile), which would
    // take a pipe's or a device's place rather than write to it.
    if (i === parts.length - 1 && !info.isFile()) {
      throw new OcraError(
        "ACCESS_DENIED",
        `Refusing to write ${path}: it is not a regular file (leave --output out to write to stdout)`,
      );
    }
    parent = current;
  }
}

/**
 * Writes the output file after refuseLinkedOutput. The text goes to a new
 * file next to it, which then replaces the path in one rename: a link put
 * there after the check is replaced rather than written through, and a CI
 * step never reads a half-written report. So the path must be one a file can
 * replace: not /dev/stdout, a pipe or a process substitution.
 */
export async function writeOutputFile(root: string, path: string, text: string): Promise<void> {
  await refuseLinkedOutput(root, path);
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  // Outside the try: a temporary file that already exists is not ours to remove.
  await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
  // A process that exits before the rename (a second Ctrl-C) leaves no
  // temporary file; only a kill can.
  const removeTemp = () => rmSync(temp, { force: true });
  process.on("exit", removeTemp);
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  } finally {
    process.off("exit", removeTemp);
  }
}

async function isWithin(root: string, dir: string): Promise<boolean> {
  const inside = relative(root, await realpath(dir));
  return inside === "" || !(inside === ".." || inside.startsWith(`..${sep}`) || parse(inside).root);
}
