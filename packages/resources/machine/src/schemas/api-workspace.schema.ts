import * as z from "zod/v4";
import { FileUploadItemSchema } from "./file.schema";

/**
 * `/api/v1/environments/:environmentId/workspace/files` 的协议 DTO。
 *
 * 从宿主 `apps/server/src/schemas/api-workspace.schema.ts` 迁入（CE 阶段 2 任务 1.3）：这两个 schema 只被
 * 本包的对外上传端点使用，属本模块的协议适配交付物；留在宿主会让「端点在包内、DTO 在宿主」形成反向依赖。
 */

/** 路径参数：目标 Environment ID。 */
export const ApiWorkspaceEnvironmentParamsSchema = z
  .object({
    environmentId: z.string().min(1).describe("Environment ID。"),
  })
  .describe("Environment Workspace 路径参数。");

/** 下载查询：文件路径相对当前 Environment 工作区。 */
export const ApiWorkspaceFileDownloadQuerySchema = z
  .object({ path: z.string().min(1).describe("待下载文件的工作区相对路径，不支持目录。") })
  .strict();

/** 外部调用使用 Bearer API Key；会话认证仍由宿主守卫处理。 */
export const ApiWorkspaceHeadersSchema = z.looseObject({
  authorization: z.string().optional().describe("Bearer <API_KEY>。"),
});

/** 下载成功使用原始文件流，不包含 JSON 包装。 */
export const ApiWorkspaceFileDownloadResponseSchema = z.file();

/** 文件树结果：目录以 / 结尾，部分目录不可读时显式列出错误。 */
export const ApiWorkspaceFileTreeResponseSchema = z.object({
  environmentId: z.string().describe("文件所属的 Environment ID。"),
  paths: z.array(z.string()).describe("相对工作区根的递归路径列表；目录以 / 结尾。"),
  mtimes: z.record(z.string(), z.number()).optional().describe("文件相对路径对应的修改时间，单位为毫秒。"),
  errors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional()
    .describe("遍历失败的相对目录与脱敏说明；存在错误时 paths 不完整。"),
});

/** 上传结果：本次成功写入的文件清单。 */
export const ApiWorkspaceFileUploadResponseSchema = z
  .object({
    environmentId: z.string().describe("文件所属的 Environment ID。"),
    files: z.array(FileUploadItemSchema).describe("本次成功上传的文件列表。"),
  })
  .describe("Workspace 文件上传响应。");
