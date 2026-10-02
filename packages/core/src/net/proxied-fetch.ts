import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

export interface ProxyEnv {
  HTTP_PROXY?: string | undefined;
  HTTPS_PROXY?: string | undefined;
  NO_PROXY?: string | undefined;
  http_proxy?: string | undefined;
  https_proxy?: string | undefined;
  no_proxy?: string | undefined;
}

// Node's own fetch ignores the proxy variables every other client reads, so
// a review behind a corporate proxy would never reach its model endpoint.
// With a proxy set, requests go through undici's fetch and its
// EnvHttpProxyAgent, reading the given environment rather than the
// process's; without one, Node's fetch is used as it is. undici's fetch and
// agent are used together so that no object crosses between it and Node's
// bundled copy (as runtime-opencode's transport does).
export function proxiedFetch(env: ProxyEnv): typeof fetch {
  const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
  if (!httpProxy && !httpsProxy) return fetch;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  const dispatcher = new EnvHttpProxyAgent({
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  });
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
