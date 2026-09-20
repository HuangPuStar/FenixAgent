import * as z from "zod/v4";
import { FileUploadItemSchema } from "./file.schema";

/**
 * `/api/environments/:environmentId/workspace/files` 的协议 DTO。
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

/** 上传结果：本次成功写入的文件清单。 */
export const ApiWorkspaceFileUploadResponseSchema = z
  .object({
    environmentId: z.string().describe("文件所属的 Environment ID。"),
    files: z.array(FileUploadItemSchema).describe("本次成功上传的文件列表。"),
  })
  .describe("Workspace 文件上传响应。");
