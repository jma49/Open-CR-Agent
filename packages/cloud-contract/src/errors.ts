import { z } from "zod";
import { DEVICE_ERRORS, type DeviceError } from "./device.js";

// ocra Cloud's refusals: a JSON body `{ "error": <code>, ... }`. Some carry more: `issues`
// (invalid_body), `limit` (daily_limit, memory_full), `version` (stale),
// `interval` (slow_down), `status` (upstream_redirect).

export const ERROR_CODES = [
  // The body does not fit the route's schema; `issues` names the fields.
  "invalid_body",
  "body_too_large",
  "unauthenticated",
  "bad_origin",
  "forbidden_for_session",
  "not_found",
  "daily_limit",
  // The web's draft started from an older version of the preferences.
  "stale",
  "version_no_longer_valid",
  "memory_full",
  "unknown_provider",
  "no_key",
  "path_not_allowed",
  "upstream_unreachable",
  // The provider answered with a redirect, which the gateway never follows:
  // it would resend the key to another address.
  "upstream_redirect",
  "confirm_with_login",
  // Sign-in on the web with GitHub.
  "bad_state",
  "github_exchange",
  "github_user",
  // Approving a device code on the web.
  "unknown_or_expired",
  "already_decided",
  "internal",
  ...DEVICE_ERRORS,
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const errorCodeSchema = z.enum(ERROR_CODES);

/**
 * The status each code answers with, whatever the route. The device
 * endpoints answer RFC 8628's codes with 400, as the RFC says, and
 * slow_down with 429 when asking for codes too fast.
 */
export const ERROR_STATUS = {
  invalid_body: 400,
  body_too_large: 413,
  unauthenticated: 401,
  bad_origin: 403,
  forbidden_for_session: 403,
  not_found: 404,
  daily_limit: 429,
  stale: 409,
  version_no_longer_valid: 409,
  memory_full: 409,
  unknown_provider: 404,
  no_key: 404,
  path_not_allowed: 404,
  upstream_unreachable: 502,
  upstream_redirect: 502,
  confirm_with_login: 400,
  bad_state: 400,
  github_exchange: 502,
  github_user: 502,
  unknown_or_expired: 404,
  already_decided: 409,
  internal: 500,
} as const satisfies Record<Exclude<ErrorCode, DeviceError>, number>;

/** Where a body did not fit, and why. */
export const bodyIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});
export type BodyIssue = z.infer<typeof bodyIssueSchema>;

/** A refusal as a client reads it: a code it does not know is still a refusal. */
export const errorAnswerSchema = z.looseObject({
  error: z.string(),
  issues: z.array(bodyIssueSchema).optional(),
});
export type ErrorAnswer = z.infer<typeof errorAnswerSchema>;
