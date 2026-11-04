import { error as logError } from "@fenix/logger";
import { ApiV1ErrSchema, ApiV1OkSchema, AppError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import {
  ApiWorkspaceEnvironmentParamsSchema,
  ApiWorkspaceFileDownloadQuerySchema,
  ApiWorkspaceFileDownloadResponseSchema,
  ApiWorkspaceFileTreeResponseSchema,
  ApiWorkspaceFileUploadResponseSchema,
  ApiWorkspaceHeadersSchema,
} from "../../../schemas/api-workspace.schema";
import { type MachineWorkspaceActor, machineWorkspaceFacade } from "../../facades/machine-workspace-facade";
import { contentDispositionAttachment, fileDownloadStream } from "../../http/file-download";
import { FileServiceError } from "../../services/file-types";
import type { WebMachineRouteDependencies } from "../dependencies";

/** v1 文件协议适配，共用已授权的本地与远程文件执行面。 */
export function createApiWorkspaceRoutes(deps: WebMachineRouteDependencies) {
  return new Elysia({ name: "api-workspaces", prefix: "/api/v1" })
    .use(deps.authGuardPlugin)
    .onError(({ error, code, set }) => {
      logError("[api-workspaces] File operation failed", error);
      const known = error instanceof AppError || error instanceof FileServiceError;
      set.status = known ? error.statusCode : code === "VALIDATION" ? 400 : 500;
      if (set.status === 429) set.headers["Retry-After"] = "1";
      return {
        success: false as const,
        error: {
          code:
            error instanceof FileServiceError
              ? error.type.toUpperCase()
              : error instanceof AppError
                ? error.code
                : code === "VALIDATION"
                  ? "VALIDATION_ERROR"
                  : "INTERNAL_ERROR",
          message: known && error.statusCode < 500 ? error.message : "File service unavailable",
        },
      };
    })
    .get(
      "/environments/:environmentId/workspace/files",
      async ({ store, params }) => ({
        success: true as const,
        data: await machineWorkspaceFacade.tree(store.authContext as MachineWorkspaceActor, params.environmentId),
      }),
      {
        sessionAuth: true,
        params: ApiWorkspaceEnvironmentParamsSchema,
        headers: ApiWorkspaceHeadersSchema,
        response: {
          200: ApiV1OkSchema(ApiWorkspaceFileTreeResponseSchema),
          400: ApiV1ErrSchema,
          401: ApiV1ErrSchema,
          403: ApiV1ErrSchema,
          404: ApiV1ErrSchema,
          429: ApiV1ErrSchema,
          500: ApiV1ErrSchema,
          503: ApiV1ErrSchema,
        },
        detail: {
          tags: ["External Workspace"],
          summary: "查询 Environment 工作区文件树",
          description:
            "递归返回整个工作区的文件与目录相对路径，目录以 / 结尾，沿用文件服务黑名单过滤；errors 非空时树不完整。",
        },
      },
    )
    .get(
      "/environments/:environmentId/workspace/files/download",
      async ({ store, params, query }) => {
        const result = await machineWorkspaceFacade.download(
          store.authContext as MachineWorkspaceActor,
          params.environmentId,
          query.path,
        );
        try {
          return new Response(fileDownloadStream(result.stream), {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": contentDispositionAttachment(result.name),
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (error) {
          result.stream.destroy();
          throw error;
        }
      },
      {
        sessionAuth: true,
        params: ApiWorkspaceEnvironmentParamsSchema,
        query: ApiWorkspaceFileDownloadQuerySchema,
        headers: ApiWorkspaceHeadersSchema,
        response: {
          200: ApiWorkspaceFileDownloadResponseSchema,
          400: ApiV1ErrSchema,
          401: ApiV1ErrSchema,
          403: ApiV1ErrSchema,
          404: ApiV1ErrSchema,
          413: ApiV1ErrSchema,
          429: ApiV1ErrSchema,
          500: ApiV1ErrSchema,
          503: ApiV1ErrSchema,
        },
        detail: {
          tags: ["External Workspace"],
          summary: "下载 Environment 工作区文件",
          description:
            "下载工作区内单个文件，成功直接返回原始文件流，错误使用统一 JSON 包装；不支持目录或越界路径。远程单文件上限 92 MiB。",
          responses: {
            200: {
              description: "文件附件流",
              content: { "application/octet-stream": { schema: { type: "string" as const, format: "binary" } } },
            },
          },
        },
      },
    )
    .post(
      "/environments/:environmentId/workspace/files",
      async ({ store, params, request }) => ({
        success: true as const,
        data: await machineWorkspaceFacade.upload(
          store.authContext as MachineWorkspaceActor,
          params.environmentId,
          () => request.formData(),
        ),
      }),
      {
        sessionAuth: true,
        parse: "none",
        params: ApiWorkspaceEnvironmentParamsSchema,
        response: {
          200: ApiV1OkSchema(ApiWorkspaceFileUploadResponseSchema),
          400: ApiV1ErrSchema,
          401: ApiV1ErrSchema,
          403: ApiV1ErrSchema,
          404: ApiV1ErrSchema,
          409: ApiV1ErrSchema,
          413: ApiV1ErrSchema,
          429: ApiV1ErrSchema,
          500: ApiV1ErrSchema,
          503: ApiV1ErrSchema,
        },
        detail: {
          tags: ["External Workspace"],
          summary: "上传 Environment 工作区文件",
          description:
            "默认写入 user/；path 可指定工作区内相对目录，空字符串或 . 表示根目录。不允许绝对路径、.. 段或软链接逃逸；同名冲突不覆盖。单文件 92 MiB，远程批次合计 92 MiB。",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object" as const,
                  required: ["files"],
                  properties: {
                    files: { type: "array" as const, items: { type: "string" as const, format: "binary" } },
                    path: {
                      type: "string" as const,
                      default: "user",
                      description: "工作区内相对目录；省略为 user，空字符串或 . 表示工作区根目录。",
                    },
                    relativePaths: { type: "string" as const },
                  },
                },
              },
            },
          },
        },
      },
    );
}
