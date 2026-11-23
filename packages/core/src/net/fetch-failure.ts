import { errnoCode, errorMessage } from "../errors.js";

const UNTRUSTED_CERTIFICATE = /SELF_SIGNED|UNABLE_TO_(VERIFY|GET_ISSUER)/;

// fetch says only "fetch failed"; its causes name the network or TLS error.
// A server whose certificate authority Node does not trust (a company's own)
// is fixed on this machine, so the message says how.
export function fetchFailure(error: unknown): string {
  // Each without its full stop, so the causes read as one sentence.
  const said = (e: unknown) => errorMessage(e).replace(/\.$/, "");
  const messages = [said(error)];
  let untrusted = false;
  let cause = error instanceof Error ? error.cause : undefined;
  while (cause instanceof Error) {
    const message = said(cause);
    if (message && !messages.includes(message)) messages.push(message);
    untrusted ||= UNTRUSTED_CERTIFICATE.test(errnoCode(cause) ?? "");
    cause = cause.cause;
  }
  return `${messages.join(": ")}${
    untrusted ? " (trust the server's certificate authority with NODE_EXTRA_CA_CERTS)" : ""
  }`;
}
