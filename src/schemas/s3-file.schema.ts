import * as z from "zod/v4";
import { OkResponseSchema } from "./common.schema";

/** 获取下载直传地址的查询参数 */
export const S3PresignGetQuerySchema = z.object({
  sessionId: z.string().min(1).describe("会话 ID。"),
  key: z.string().min(1).describe("S3 对象 key。"),
});

/** 下载直传地址响应 */
export const S3PresignGetResponseSchema = z.object({
  url: z.string().describe("下载用的 presigned URL。"),
  key: z.string().describe("对应的 S3 对象 key。"),
  expiresAt: z.number().describe("URL 过期时间戳，单位为毫秒。"),
});

/** 获取上传直传地址的请求体 */
export const S3PresignPutBodySchema = z.object({
  sessionId: z.string().min(1).describe("会话 ID。"),
  key: z.string().min(1).describe("目标 S3 对象 key。"),
  contentType: z.string().min(1).describe("上传文件的 Content-Type。"),
});

/** 上传直传地址响应 */
export const S3PresignPutResponseSchema = z.object({
  url: z.string().describe("上传用的 presigned URL。"),
  key: z.string().describe("对应的 S3 对象 key。"),
  expiresAt: z.number().describe("URL 过期时间戳，单位为毫秒。"),
});

/** 删除文件请求体 */
export const S3DeleteBodySchema = z.object({
  sessionId: z.string().min(1).describe("会话 ID。"),
  key: z.string().min(1).describe("要删除的 S3 对象 key。"),
});

/** 服务端上传查询参数 */
export const S3UploadQuerySchema = z.object({
  sessionId: z.string().min(1).describe("会话 ID。"),
});

/** 服务端上传响应 */
export const S3UploadResponseSchema = z.object({
  files: z
    .array(
      z.object({
        key: z.string().describe("上传后的 S3 对象 key。"),
        name: z.string().describe("原始文件名。"),
        size: z.number().describe("文件大小，单位为字节。"),
      }),
    )
    .describe("本次成功上传的文件列表。"),
});

/** 列举 S3 文件查询参数 */
export const S3FileListQuerySchema = z.object({
  sessionId: z.string().min(1).describe("会话 ID。"),
  prefix: z.string().optional().describe("可选前缀，用于筛选子目录。"),
});

/** 单个 S3 文件条目 */
export const S3FileEntrySchema = z.object({
  key: z.string().describe("S3 对象完整 key。"),
  name: z.string().describe("相对于当前前缀的文件名。"),
  size: z.number().describe("文件大小，单位为字节。"),
  lastModified: z.number().describe("最后修改时间戳，单位为毫秒。"),
});

/** S3 文件列表响应 */
export const S3FileListResponseSchema = z.object({
  entries: S3FileEntrySchema.array().describe("当前前缀下的文件列表。"),
  prefix: z.string().describe("本次查询使用的前缀。"),
});

/** 删除 S3 文件响应 */
export const S3DeleteResponseSchema = OkResponseSchema.describe("删除文件后的成功响应。");

export type S3PresignGetQuery = z.infer<typeof S3PresignGetQuerySchema>;
export type S3PresignGetResponse = z.infer<typeof S3PresignGetResponseSchema>;
export type S3PresignPutBody = z.infer<typeof S3PresignPutBodySchema>;
export type S3PresignPutResponse = z.infer<typeof S3PresignPutResponseSchema>;
export type S3DeleteBody = z.infer<typeof S3DeleteBodySchema>;
export type S3DeleteResponse = z.infer<typeof S3DeleteResponseSchema>;
export type S3UploadResponse = z.infer<typeof S3UploadResponseSchema>;
export type S3FileListQuery = z.infer<typeof S3FileListQuerySchema>;
export type S3FileEntry = z.infer<typeof S3FileEntrySchema>;
export type S3FileListResponse = z.infer<typeof S3FileListResponseSchema>;
