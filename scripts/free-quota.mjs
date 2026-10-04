// OpenRouter's free requests left today, from one chat request of one token
// to the free model: its rate-limit headers, or the 429 that refuses it. Each
// probe spends one request. GET /key's free_model_daily_requests is another
// pool (limit 50) that these requests do not count against. Prints the count,
// or nothing when OpenRouter does not say; logs the probe on stderr.
//
//   OPENROUTER_API_KEY=… node scripts/free-quota.mjs <model>
import { freeRequestsLeft, probeLine, probeRequest } from "./lib/free-quota.mjs";

const model = process.argv[2];
const key = process.env.OPENROUTER_API_KEY;
if (!model || !key) {
  console.error("usage: OPENROUTER_API_KEY=… node scripts/free-quota.mjs <model>");
  process.exit(2);
}
let headers = new Headers();
let body = "";
/** @type {Response | undefined} */
let response;
try {
  response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(probeRequest(model)),
    signal: AbortSignal.timeout(30_000),
  });
  headers = response.headers;
  body = await response.text();
} catch {
  // No answer: the count stays unknown, as when OpenRouter does not say.
}
const left = freeRequestsLeft(headers, body);
console.error(probeLine(response, headers, left));
if (left !== undefined) console.log(left);
