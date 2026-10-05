import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { UsageError } from "./usage-error.js";

const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL, O_NOFOLLOW } = constants;

// Writes path under the repository root. The repository may be someone
// else's clone: a planted symbolic link at the file or at any directory on
// the way (.ocra, .github) must not make ocra write elsewhere. Without
// replace, an existing file is kept, decided by the open itself (O_EXCL)
// rather than by a check before it.
export async function writeRepositoryFile(
  root: string,
  path: string,
  content: string,
  { replace }: { replace: boolean },
): Promise<"written" | "exists"> {
  const target = join(root, path);
  const parts = relative(root, target).split(sep);
  for (let i = 1; i <= parts.length; i += 1) {
    const p = join(root, ...parts.slice(0, i));
    const stat = await lstat(p).catch(() => undefined);
    if (stat?.isSymbolicLink())
      throw new UsageError(`Refusing to write through the symbolic link ${p}`);
  }
  await mkdir(dirname(target), { recursive: true });
  const flags = O_WRONLY | O_CREAT | O_NOFOLLOW | (replace ? O_TRUNC : O_EXCL);
  const handle = await open(target, flags).catch((error: NodeJS.ErrnoException) => {
    if (!replace && error.code === "EEXIST") return undefined;
    throw error;
  });
  if (!handle) return "exists";
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return "written";
}
