import Elysia from "elysia";
import * as z from "zod/v4";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import {
  ApiWorkspaceEnvironmentParamsSchema,
  ApiWorkspaceFileUploadResponseSchema,
} from "../../schemas/api-workspace.schema";
import { uploadWorkspaceFiles } from "../../services/api-workspace";

const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().describe("错误码。"),
    message: z.string().describe("错误描述。"),
  }),
});

function mapApiError(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (error instanceof Error && "statusCode" in error && "code" in error) {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    const code = typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
    return { status: statusCode, body: { error: { code, message: error.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unknown error" } },
  };
}

const app = new Elysia({ name: "api-workspaces", prefix: "/api" }).use(authGuardPlugin).model({
  "api-workspace-environment-params": ApiWorkspaceEnvironmentParamsSchema,
  "api-workspace-upload-response": ApiWorkspaceFileUploadResponseSchema,
});

app.post(
  "/environments/:environmentId/workspace/files",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia multipart 解析与 response schema 组合时类型推断不稳定
  async ({ store, params, request, error }: any): Promise<any> => {
    const authCtx = store.authContext as AuthContext;
    try {
      const formData = await request.formData();
      return await uploadWorkspaceFiles(authCtx, params.environmentId, formData);
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-workspace-environment-params",
    response: {
      200: "api-workspace-upload-response",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      413: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Workspace"],
      summary: "上传 Workspace 文件",
      description:
        "使用 multipart/form-data 上传文件到指定 environment 的 workspace/user 目录。表单字段：files（必填），path（可选，默认 user），relativePaths（可选 JSON 数组）。",
    },
  },
);

export default app;
