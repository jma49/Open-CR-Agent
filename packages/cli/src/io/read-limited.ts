/**
 * The response's body as text, read up to `maxBytes`; undefined, with the
 * rest of the body cancelled, when it is longer. Stops reading at the limit
 * instead of buffering whatever the server sends.
 */
export async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
