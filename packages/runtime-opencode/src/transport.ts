import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";

// OpenCode answers a prompt only when the agent has finished, which can take
// longer than fetch's default 300 s header and body timeouts; on Node those
// end the request as an error that is not an abort (the SDK's
// `timeout = false` only works on Bun). The task's own timeout and abort
// signal bound each request instead. undici's fetch and Agent are used
// together so no object crosses between it and Node's bundled copy.
export function createUntimedDispatcher(): Agent {
  return new Agent({ headersTimeout: 0, bodyTimeout: 0 });
}

// The adapter from undici's fetch to Node's is a deliberate copy of the one in
// core's proxiedFetch: a runtime builds on core's public API only (ADR-0006),
// and sharing it there would put undici's Dispatcher type in core's contract
// and pass a dispatcher from this package's undici to core's copy.
export function untimedFetch(dispatcher: Dispatcher): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = request.body === null ? undefined : await request.arrayBuffer();
    const response = await undiciFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      ...(body === undefined ? {} : { body }),
      signal: request.signal,
      dispatcher,
    });
    return response as unknown as Response;
  };
}
