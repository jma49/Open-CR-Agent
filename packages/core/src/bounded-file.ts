import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { OcraError } from "./errors.js";

const CHUNK_BYTES = 1024 * 1024;

/**
 * A regular file's text, read until at most maxBytes, counted as read rather
 * than taken from stat: a device, a pipe or a file growing while it is read
 * cannot make ocra buffer without end. Without followLinks a symbolic link is
 * refused (ACCESS_DENIED), checked and then opened with O_NOFOLLOW. Opening
 * never blocks on a pipe (O_NONBLOCK). Other errors, such as a missing file,
 * are the caller's to explain.
 */
export async function readBoundedFile(
  path: string,
  { maxBytes, followLinks }: { maxBytes: number; followLinks: boolean },
): Promise<string> {
  // Where the platform lacks O_NOFOLLOW or O_NONBLOCK (Windows), they are
  // undefined and add nothing; the lstat before still refuses a link.
  const flags =
    constants.O_RDONLY | constants.O_NONBLOCK | (followLinks ? 0 : constants.O_NOFOLLOW);
  if (!followLinks && (await lstat(path)).isSymbolicLink()) throw linked(path);
  const handle = await open(path, flags).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ELOOP" || error.code === "EMLINK" ? linked(path) : error;
  });
  try {
    if (!(await handle.stat()).isFile()) {
      throw new OcraError("INPUT_INVALID", `${path} is not a regular file`);
    }
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) return Buffer.concat(chunks, total).toString("utf8");
      total += bytesRead;
      if (total > maxBytes) {
        throw new OcraError("INPUT_INVALID", `${path} is larger than ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    await handle.close();
  }
}

function linked(path: string): OcraError {
  return new OcraError("ACCESS_DENIED", `${path} is a symbolic link`);
}
