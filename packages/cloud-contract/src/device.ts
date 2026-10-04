import { z } from "zod";

// `ocra login`: the OAuth 2.0 device authorization grant (RFC 8628). The CLI
// asks for a code, the person approves it on the web, and the CLI's polling
// receives a session's tokens. The refresh rotates them.

/** POST /api/device/code. The name labels the session on the web; anything else is ignored. */
export const deviceCodeRequestSchema = z.object({
  client_name: z.string().optional().catch(undefined),
});

/** The answer to POST /api/device/code (RFC 8628, 3.2). */
export const deviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string(),
  verification_uri_complete: z.string().min(1),
  expires_in: z.number().optional(),
  interval: z.number().optional(),
});
export type DeviceCode = z.infer<typeof deviceCodeSchema>;

/** POST /api/device/token: one poll (RFC 8628, 3.4). */
export const deviceTokenRequestSchema = z.object({ device_code: z.string() });
/** POST /api/device/refresh. */
export const refreshRequestSchema = z.object({ refresh_token: z.string() });

/** RFC 8628, 3.5: the device endpoints answer these, not ocra Cloud's other codes. */
export const DEVICE_ERRORS = [
  "invalid_request",
  "invalid_grant",
  "expired_token",
  "authorization_pending",
  "slow_down",
  "access_denied",
] as const;
export type DeviceError = (typeof DEVICE_ERRORS)[number];

/** The device flow's and the refresh's token answer (RFC 8628, 3.5); every field may be absent. */
export const tokenAnswerSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  error: z.string().optional(),
  interval: z.number().optional(),
});
export type TokenAnswer = z.infer<typeof tokenAnswerSchema>;

/** GET /api/me, as a client needs it. */
export const accountSchema = z.object({ login: z.string() });

/** GET /api/account/salt: the account's repository-hash salt, null while it shares no findings. */
export const saltSchema = z.object({
  salt: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
