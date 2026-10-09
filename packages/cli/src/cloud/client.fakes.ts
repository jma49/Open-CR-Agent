// An ocra Cloud answer far longer than any it gives, for the read limits.

/** A JSON answer of `entries` that go on for `mb` megabytes; `read` counts the bytes pulled. */
export function endlessMemory(mb: number) {
  const chunk = new TextEncoder().encode(`${JSON.stringify({ fingerprint: "f".repeat(1000) })},`);
  const total = (mb * 1024 * 1024) / chunk.byteLength;
  const counter = { read: 0 };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"entries":['));
    },
    pull(controller) {
      if (sent >= total) {
        controller.enqueue(new TextEncoder().encode("{}]}"));
        controller.close();
        return;
      }
      sent += 1;
      counter.read += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { answer: () => new Response(body), counter };
}
