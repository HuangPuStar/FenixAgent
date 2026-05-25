import * as z from "zod/v4";

export const S3PresignGetQuerySchema = z.object({
  sessionId: z.string().min(1),
  key: z.string().min(1),
});

export const S3PresignGetResponseSchema = z.object({
  url: z.string(),
  key: z.string(),
  expiresAt: z.number(),
});

export const S3PresignPutBodySchema = z.object({
  sessionId: z.string().min(1),
  key: z.string().min(1),
  contentType: z.string().min(1),
});

export const S3PresignPutResponseSchema = z.object({
  url: z.string(),
  key: z.string(),
  expiresAt: z.number(),
});

export const S3DeleteBodySchema = z.object({
  sessionId: z.string().min(1),
  key: z.string().min(1),
});

export const S3UploadQuerySchema = z.object({
  sessionId: z.string().min(1),
});

export const S3UploadResponseSchema = z.object({
  files: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      size: z.number(),
    }),
  ),
});

export const S3FileListQuerySchema = z.object({
  sessionId: z.string().min(1),
  prefix: z.string().optional(),
});

export const S3FileEntrySchema = z.object({
  key: z.string(),
  name: z.string(),
  size: z.number(),
  lastModified: z.number(),
});

export const S3FileListResponseSchema = z.object({
  entries: S3FileEntrySchema.array(),
  prefix: z.string(),
});

export type S3PresignGetQuery = z.infer<typeof S3PresignGetQuerySchema>;
export type S3PresignGetResponse = z.infer<typeof S3PresignGetResponseSchema>;
export type S3PresignPutBody = z.infer<typeof S3PresignPutBodySchema>;
export type S3PresignPutResponse = z.infer<typeof S3PresignPutResponseSchema>;
export type S3DeleteBody = z.infer<typeof S3DeleteBodySchema>;
export type S3UploadResponse = z.infer<typeof S3UploadResponseSchema>;
export type S3FileListQuery = z.infer<typeof S3FileListQuerySchema>;
export type S3FileEntry = z.infer<typeof S3FileEntrySchema>;
export type S3FileListResponse = z.infer<typeof S3FileListResponseSchema>;
