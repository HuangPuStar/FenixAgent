import * as z from "zod/v4";

export const SystemLogFileSchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime(),
  isErrorLog: z.boolean(),
});

export const SystemLogFilesResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ files: SystemLogFileSchema.array() }),
});

export const SystemLogSearchQuerySchema = z.object({
  file: z.string().min(1).max(255),
  q: z.string().max(200).optional(),
  errorOnly: z.stringbool().optional().default(false),
  limit: z.coerce.number().int().min(1).max(1_000).optional().default(500),
});

export const SystemLogSearchResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    file: SystemLogFileSchema,
    entries: z.array(
      z.object({
        timestamp: z.string().nullable(),
        level: z.string().nullable(),
        module: z.string().nullable(),
        requestId: z.string().nullable(),
        message: z.string(),
        error: z
          .object({ type: z.string().nullable(), message: z.string().nullable(), stack: z.string().nullable() })
          .nullable(),
      }),
    ),
    totalMatches: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
});

export const SystemLogDownloadQuerySchema = z.object({
  file: z.string().min(1).max(255),
});
