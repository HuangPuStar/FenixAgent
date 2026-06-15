import * as z from "zod/v4";

/** 目录项或文件项 */
export const FileEntrySchema = z.object({
  name: z.string().describe("文件或目录名称。"),
  path: z.string().describe("相对工作区的展示路径；用户目录通常以 user/ 开头。"),
  type: z.enum(["dir", "file"]).describe("条目类型，dir 表示目录，file 表示文件。"),
  size: z.number().describe("文件大小，单位为字节；目录固定为 0。"),
  modifiedAt: z.number().describe("最后修改时间戳，单位为毫秒。"),
});

/** 目录列表响应 */
export const FileListResponseSchema = z.object({
  entries: FileEntrySchema.array().describe("当前目录下可见的文件与目录列表。"),
});

/** 文本文件内容响应 */
export const FileContentSchema = z.object({
  name: z.string().describe("文件名称。"),
  path: z.string().describe("文件相对路径。"),
  content: z.string().describe("文件文本内容。"),
  size: z.number().describe("文件大小，单位为字节。"),
  encoding: z.string().describe("文本编码；当前通常为 utf-8。"),
});

/** 单个上传文件结果 */
export const FileUploadItemSchema = z.object({
  name: z.string().describe("上传文件名称。"),
  path: z.string().describe("上传完成后的文件路径。"),
  size: z.number().describe("上传文件大小，单位为字节。"),
});

/** 文件上传响应 */
export const FileUploadResponseSchema = z.object({
  files: FileUploadItemSchema.array().describe("本次成功上传的文件列表。"),
});

/** 写入文件成功结果 */
export const FileWriteResultSchema = z.object({
  name: z.string().describe("写入的文件名称。"),
  path: z.string().describe("写入后的文件路径。"),
  size: z.number().describe("写入后文件大小，单位为字节。"),
});

/** 写入文件请求体 */
export const WriteFileRequestSchema = z.object({
  content: z.string().describe("要写入文件的文本内容；允许为空字符串。"),
});

/** 递归文件树响应 */
export const TreeResponseSchema = z.object({
  paths: z.array(z.string()).describe("递归展开后的路径列表；目录通常以 / 结尾。"),
  mtimes: z.record(z.string(), z.number()).optional().describe("部分文件路径对应的修改时间戳，单位为毫秒。"),
});

/** 重命名请求体 */
export const RenameRequestSchema = z.object({
  oldPath: z.string().min(1).describe("原始路径。"),
  newPath: z.string().min(1).describe("目标路径。"),
});

/** 重命名响应 */
export const RenameResponseSchema = z.object({
  oldPath: z.string().describe("原始路径。"),
  newPath: z.string().describe("更新后的目标路径。"),
});

/** 创建目录请求体 */
export const MkdirRequestSchema = z.object({
  path: z.string().min(1).describe("要创建的目录路径。"),
});

/** 创建目录响应 */
export const MkdirResponseSchema = z.object({
  path: z.string().describe("已创建的目录路径。"),
});

/** 批量删除请求体 */
export const BatchDeleteRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).describe("要批量删除的路径列表。"),
});

/** 批量删除响应 */
export const BatchDeleteResponseSchema = z.object({
  deleted: z.array(z.string()).describe("成功删除的路径列表。"),
  failed: z
    .array(
      z.object({
        path: z.string().describe("删除失败的路径。"),
        error: z.string().describe("删除失败原因。"),
      }),
    )
    .describe("删除失败的路径及错误信息。"),
});

export type FileEntry = z.infer<typeof FileEntrySchema>;
export type FileListResponse = z.infer<typeof FileListResponseSchema>;
export type FileContent = z.infer<typeof FileContentSchema>;
export type FileUploadResponse = z.infer<typeof FileUploadResponseSchema>;
export type FileWriteResult = z.infer<typeof FileWriteResultSchema>;
