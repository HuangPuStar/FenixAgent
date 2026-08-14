import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";

/** 写操作成功响应（§7.2 op_id 回显契约）：op_id 与 success/data 平级（消费者
 *  解包 data 不受影响），X-File-Op-Id 请求头原样回显；未携带时缺省（响应结构
 *  与现状一致）。 */
const WriteOkSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
    op_id: z.string().optional().describe("幂等操作标识（X-File-Op-Id 请求头原样回显）；未携带时缺省。"),
  });

/** 目录项或文件项 */
export const FileEntrySchema = z.object({
  name: z.string().describe("文件或目录名称。"),
  path: z.string().describe("相对工作区的展示路径；用户目录通常以 user/ 开头。"),
  type: z.enum(["dir", "file"]).describe("条目类型，dir 表示目录，file 表示文件。"),
  size: z.number().describe("文件大小，单位为字节；目录固定为 0。"),
  modifiedAt: z.number().describe("最后修改时间戳，单位为毫秒。"),
});

/** 目录列表响应 */
export const FileListResponseSchema = WebOkSchema(
  z.object({
    entries: FileEntrySchema.array().describe("当前目录下可见的文件与目录列表。"),
  }),
).describe("目录列表响应。");

/** 文本文件内容响应 */
export const FileContentSchema = WebOkSchema(
  z.object({
    name: z.string().describe("文件名称。"),
    path: z.string().describe("文件相对路径。"),
    content: z.string().describe("文件文本内容。"),
    size: z.number().describe("文件大小，单位为字节。"),
    encoding: z.string().describe("文本编码；当前通常为 utf-8。"),
    type: z
      .enum(["text", "binary"])
      .optional()
      .describe("内容类型显式标记（§7.8）；文本响应恒为 text，auto 模式回退二进制的流响应经 X-File-Type 头标记。"),
  }),
).describe("文本文件内容响应。");

/** 单个上传文件结果 */
export const FileUploadItemSchema = z.object({
  name: z.string().describe("上传文件名称。"),
  path: z.string().describe("上传完成后的文件路径。"),
  size: z.number().describe("上传文件大小，单位为字节。"),
});

/** 文件上传响应 */
export const FileUploadResponseSchema = WriteOkSchema(
  z.object({
    files: FileUploadItemSchema.array().describe("本次成功上传的文件列表。"),
  }),
).describe("文件上传响应。");

/** 写入文件成功结果 */
export const FileWriteResultSchema = WriteOkSchema(
  z.object({
    name: z.string().describe("写入的文件名称。"),
    path: z.string().describe("写入后的文件路径。"),
    size: z.number().describe("写入后文件大小，单位为字节。"),
  }),
).describe("写入文件成功结果。");

/** 写入文件请求体 */
export const WriteFileRequestSchema = z.object({
  content: z.string().describe("要写入文件的文本内容；允许为空字符串。"),
});

/** 递归文件树响应 */
export const TreeResponseSchema = WebOkSchema(
  z.object({
    paths: z.array(z.string()).describe("递归展开后的路径列表；目录通常以 / 结尾。"),
    mtimes: z.record(z.string(), z.number()).optional().describe("部分文件路径对应的修改时间戳，单位为毫秒。"),
    errors: z
      .array(
        z.object({
          path: z.string().describe("遍历失败的目录路径。"),
          message: z.string().describe("错误描述信息。"),
        }),
      )
      .optional()
      .describe("部分目录遍历失败时的路径和错误信息；成功时为 null 或空数组。"),
  }),
).describe("递归文件树响应。");

/** 重命名请求体 */
export const RenameRequestSchema = z.object({
  oldPath: z.string().min(1).describe("原始路径。"),
  newPath: z.string().min(1).describe("目标路径。"),
});

/** 重命名响应 */
export const RenameResponseSchema = WriteOkSchema(
  z.object({
    oldPath: z.string().describe("原始路径。"),
    newPath: z.string().describe("更新后的目标路径。"),
  }),
).describe("重命名响应。");

/** 创建目录请求体 */
export const MkdirRequestSchema = z.object({
  path: z.string().min(1).describe("要创建的目录路径。"),
});

/** 创建目录响应 */
export const MkdirResponseSchema = WriteOkSchema(
  z.object({
    path: z.string().describe("已创建的目录路径。"),
  }),
).describe("创建目录响应。");

/** 删除文件响应（§7.2 op_id 回显：delete 端点原用通用 OkResponseSchema，无法承载
 *  回显字段，单独定义；结构与 OkResponseSchema 一致，仅增加可选 op_id） */
export const DeleteFileResponseSchema = WriteOkSchema(
  z.object({
    ok: z.literal(true),
  }),
).describe("删除文件响应。");

/** 批量删除请求体 */
export const BatchDeleteRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).describe("要批量删除的路径列表。"),
});

/** 批量删除响应 */
export const BatchDeleteResponseSchema = WriteOkSchema(
  z.object({
    deleted: z.array(z.string()).describe("成功删除的路径列表。"),
    failed: z
      .array(
        z.object({
          path: z.string().describe("删除失败的路径。"),
          error: z.string().describe("删除失败原因。"),
        }),
      )
      .describe("删除失败的路径及错误信息。"),
  }),
).describe("批量删除响应。");

export type FileEntry = z.infer<typeof FileEntrySchema>;
export type FileListResponse = z.infer<typeof FileListResponseSchema>;
export type FileContent = z.infer<typeof FileContentSchema>;
export type FileUploadResponse = z.infer<typeof FileUploadResponseSchema>;
export type FileWriteResult = z.infer<typeof FileWriteResultSchema>;
