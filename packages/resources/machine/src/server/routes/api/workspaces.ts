import { error as logError } from "@fenix/logger";
import { ApiV1ErrSchema, ApiV1OkSchema, AppError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import {
  ApiWorkspaceEnvironmentParamsSchema,
  ApiWorkspaceFileUploadResponseSchema,
} from "../../../schemas/api-workspace.schema";
import { type MachineWorkspaceActor, machineWorkspaceFacade } from "../../facades/machine-workspace-facade";
import { FileServiceError } from "../../services/file-types";
import type { WebMachineRouteDependencies } from "../dependencies";

/** v1 multipart adapter over the common authorized file execution plane. */
export function createApiWorkspaceRoutes(deps: WebMachineRouteDependencies) {
  return new Elysia({ name: "api-workspaces", prefix: "/api/v1" })
    .use(deps.authGuardPlugin)
    .onError(({ error, code, set }) => {
      logError("[api-workspaces] Upload failed", error);
      const known = error instanceof AppError || error instanceof FileServiceError;
      set.status = known ? error.statusCode : code === "VALIDATION" ? 400 : 500;
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
          description: "只写 user/ 子树；同名冲突不覆盖。单文件 92 MiB，远程批次合计 92 MiB。",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object" as const,
                  required: ["files"],
                  properties: {
                    files: { type: "array" as const, items: { type: "string" as const, format: "binary" } },
                    path: { type: "string" as const, default: "user" },
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
