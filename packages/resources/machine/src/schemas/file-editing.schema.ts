import { z } from "zod/v4";

/** Machine's independent protocol DTOs; provider configuration remains opaque. */
export const EditingSessionStatusSchema = z.object({
  id: z.string(),
  state: z.enum(["opening", "editing", "saving", "conflict", "save-failed", "closing", "closed", "expired"]),
  conflict: z.boolean(),
  version: z.string(),
  lastSavedAt: z.number().nullable(),
  expiresAt: z.number(),
  saveId: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
/** Office bootstrap payload is forwarded without Machine interpreting provider details. */
export const EditingSessionSchema = EditingSessionStatusSchema.extend({
  initialization: z.object({ scriptUrl: z.string(), config: z.record(z.string(), z.unknown()) }),
  maxBytes: z.number(),
});
/** Capabilities are resolved for the authenticated environment. */
export const EditingCapabilitiesSchema = z.object({
  textMaxBytes: z.number(),
  office: z.object({
    enabled: z.boolean(),
    extensions: z.array(z.string()),
    maxBytes: z.number(),
    reason: z.string().optional(),
  }),
});
/** Session creation accepts a workspace-relative path and optional interface language only. */
export const OpenEditingSessionSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  lang: z.string().max(32).optional(),
});
/** Common error envelope matches request/unwrap's code-based error semantics. */
export const EditingErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});
/** Stable session ID from the server; never a document/callback access token. */
export const EditingSessionParamsSchema = z.object({ id: z.string().min(1).max(200) });
