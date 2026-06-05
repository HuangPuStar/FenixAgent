import * as z from "zod/v4";

export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["dir", "file"]),
  size: z.number(),
  modifiedAt: z.number(),
});

export const FileListResponseSchema = z.object({
  entries: FileEntrySchema.array(),
});

export const FileContentSchema = z.object({
  name: z.string(),
  path: z.string(),
  content: z.string(),
  size: z.number(),
  encoding: z.string(),
});

export const FileUploadItemSchema = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number(),
});

export const FileUploadResponseSchema = z.object({
  files: FileUploadItemSchema.array(),
});

export const FileWriteResultSchema = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number(),
});

export const WriteFileRequestSchema = z.object({
  content: z.string().min(1, "content field required"),
});

export const TreeResponseSchema = z.object({
  paths: z.array(z.string()),
  mtimes: z.record(z.string(), z.number()).optional(),
});

export const RenameRequestSchema = z.object({
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
});

export const RenameResponseSchema = z.object({
  oldPath: z.string(),
  newPath: z.string(),
});

export const MkdirRequestSchema = z.object({
  path: z.string().min(1),
});

export const MkdirResponseSchema = z.object({
  path: z.string(),
});

export const BatchDeleteRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
});

export const BatchDeleteResponseSchema = z.object({
  deleted: z.array(z.string()),
  failed: z.array(z.object({ path: z.string(), error: z.string() })),
});

export type FileEntry = z.infer<typeof FileEntrySchema>;
export type FileListResponse = z.infer<typeof FileListResponseSchema>;
export type FileContent = z.infer<typeof FileContentSchema>;
export type FileUploadResponse = z.infer<typeof FileUploadResponseSchema>;
export type FileWriteResult = z.infer<typeof FileWriteResultSchema>;
