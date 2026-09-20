import { ApiErrorResponseSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import {
  ApiWorkspaceEnvironmentParamsSchema,
  ApiWorkspaceFileUploadResponseSchema,
} from "../../../schemas/api-workspace.schema";
import { uploadWorkspaceFiles } from "../../services/api-workspace";
import type { MachineRequestAuth } from "../../types/auth";
import type { WebMachineRouteDependencies } from "../dependencies";

/**
 * 把服务层错误映射成 `/api` 错误信封。
 *
 * 信封形状（`error.code` / `error.message`）是 platform-sdk 的稳定合同，响应 schema 直接从
 * `@fenix/platform-sdk` 取用——包内复制一份 `z.object({ error: ... })` 会在平台契约演进时静默漂移，
 * 也让 OpenAPI 多出一份「看起来一样」的本地定义。
 *
 * 已知分歧（不在本包修）：宿主 `apps/server/src/plugins/error-handler.ts` 的兜底响应目前用 `type`
 * 字段，与平台契约的 `code` 不一致；本包按平台契约取值，收敛归宿主错误处理（§1.7）。
 */
function mapApiError(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (error instanceof Error && "statusCode" in error && "code" in error) {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    const code = typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
    if (statusCode < 500) return { status: statusCode, body: { error: { code, message: error.message } } };
  }
  console.error("[api-workspaces] upload error:", error);
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
  };
}

/**
 * `/api/environments/:environmentId/workspace/files` — 对外稳定 API 的 workspace 上传端点。
 *
 * 改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 `macro` / `state` 是实例作用域的，父实例无法
 * 向已构造的子实例回填），因此由宿主注入 `authGuardPlugin`。
 */
export function createApiWorkspaceRoutes(deps: WebMachineRouteDependencies) {
  const app = new Elysia({ name: "api-workspaces", prefix: "/api" }).use(deps.authGuardPlugin).model({
    "api-workspace-environment-params": ApiWorkspaceEnvironmentParamsSchema,
    "api-workspace-upload-response": ApiWorkspaceFileUploadResponseSchema,
  });

  app.post(
    "/environments/:environmentId/workspace/files",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia multipart 解析与 response schema 组合时类型推断不稳定
    async ({ store, params, request, error }: any): Promise<any> => {
      const authCtx = store.authContext as MachineRequestAuth;
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

  return app;
}
