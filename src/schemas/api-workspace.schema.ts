import * as z from "zod/v4";
import { FileUploadItemSchema } from "./file.schema";

export const ApiWorkspaceEnvironmentParamsSchema = z
  .object({
    environmentId: z.string().min(1).describe("Environment ID。"),
  })
  .describe("Environment Workspace 路径参数。");

export const ApiWorkspaceFileUploadResponseSchema = z
  .object({
    environmentId: z.string().describe("文件所属的 Environment ID。"),
    files: z.array(FileUploadItemSchema).describe("本次成功上传的文件列表。"),
  })
  .describe("Workspace 文件上传响应。");
