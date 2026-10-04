import { z } from "zod";

// ocra Cloud's answers as they arrive on the wire. Each is checked here,
// before the client turns it into the values its callers use; the server
// is ocra's own, but a proxy, an older server or a bug can answer anything.

/** The device flow's and the refresh's token answer (RFC 8628, 3.5); every field may be absent. */
export const tokenAnswerSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  error: z.string().optional(),
  interval: z.number().optional(),
});
export type TokenAnswer = z.infer<typeof tokenAnswerSchema>;

export const deviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string(),
  verification_uri_complete: z.string().min(1),
  expires_in: z.number().optional(),
  interval: z.number().optional(),
});
export type DeviceCode = z.infer<typeof deviceCodeSchema>;

export const accountSchema = z.object({ login: z.string() });

const SALT = /^[0-9a-f]{64}$/;
// The account's repository-hash salt; null while the account shares no findings.
export const saltSchema = z.object({ salt: z.string().regex(SALT).nullable() });

// Read field by field by parseAccountSettings and parseAccountPlugins.
export const preferencesSchema = z.record(z.string(), z.unknown());

// Each entry is read on its own by parseAccountMemory, which skips what it cannot use.
export const memorySchema = z.object({ entries: z.array(z.unknown()) });

// How many shared findings the server kept; anything else counts as none.
export const uploadAnswerSchema = z.object({
  findings: z.number().int().positive().optional().catch(undefined),
});
