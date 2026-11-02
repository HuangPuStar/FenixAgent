import type { AnyElysia } from "elysia";
import type { CloudDriveFacade } from "../../facades/cloud-drive-facade";
import {
  CloudDriveFileParamsSchema,
  CloudDriveMutationResponseSchema,
  CloudDriveTrashPageResponseSchema,
  CloudDriveTrashParamsSchema,
  CreateCloudDriveDirectoryBodySchema,
  MoveCloudDriveFileBodySchema,
  RestoreCloudDriveTrashBodySchema,
} from "../../schemas/cloud-drive.schema";
import { actorFromStore } from "../dependencies";
import { respondToWeb, respondUnauthorized, WEB_ERROR_RESPONSES, type WebRouteContext } from "./cloud-drive-response";

/**
 * 变更路径：建目录、改名/移动、删除、回收站列表与恢复。
 *
 * 所有写操作都经 Facade 编排：需要 `expected_metadata_revision` 的动作（改名/移动/删除/覆盖写）由
 * Facade 先读元数据再提交，前端不需要自己跟踪 revision；恢复是唯一例外——已进回收站的文件无法再
 * `GET /v1/files/{id}`，所以 `expectedMetadataRevision` 必须由前端从回收站条目的
 * `file.metadataRevision` 带上（见 {@link RestoreCloudDriveTrashBodySchema}）。
 */
export function registerCloudDriveMutationRoutes(app: AnyElysia, facade: CloudDriveFacade): void {
  app.post(
    "/cloud-drive/directories",
    async ({ store, body, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      const payload = body as { name: string; parentId?: string | null };
      return respondToWeb(
        await facade.createDirectory(actor, { name: payload.name, parentId: payload.parentId }),
        error,
      );
    },
    {
      sessionAuth: true,
      body: CreateCloudDriveDirectoryBodySchema,
      response: { 200: CloudDriveMutationResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "新建目录",
        description: "在 parentId（省略或 null 表示根目录）下创建目录；同名冲突返回 409。",
      },
    },
  );

  app.patch(
    "/cloud-drive/files/:id/location",
    async ({ store, params, body, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      const payload = body as { name?: string; parentId?: string | null };
      return respondToWeb(
        await facade.moveFile(actor, params.id, { name: payload.name, parentId: payload.parentId }),
        error,
      );
    },
    {
      sessionAuth: true,
      params: CloudDriveFileParamsSchema,
      body: MoveCloudDriveFileBodySchema,
      response: { 200: CloudDriveMutationResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "改名或移动文件/目录",
        description:
          "只需提供 name 与 parentId 中至少一项；parentId 为 null 表示移动到根目录。并发修改导致 revision 变化时返回 409，请刷新后重试。",
      },
    },
  );

  app.delete(
    "/cloud-drive/files/:id",
    async ({ store, params, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(await facade.deleteFile(actor, params.id), error);
    },
    {
      sessionAuth: true,
      params: CloudDriveFileParamsSchema,
      response: { 200: CloudDriveMutationResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "删除文件或目录",
        description: "移入 CloudDrive 回收站（不物理删除），可用 GET /cloud-drive/trash 查看并恢复。",
      },
    },
  );

  app.get(
    "/cloud-drive/trash",
    async ({ store, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(await facade.listTrash(actor), error);
    },
    {
      sessionAuth: true,
      response: { 200: CloudDriveTrashPageResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "列出回收站",
        description: "返回当前用户回收站中的条目；每条带 `file.metadataRevision`，恢复时需要原样回传。",
      },
    },
  );

  app.post(
    "/cloud-drive/trash/:id/restore",
    async ({ store, params, body, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      const payload = body as { expectedMetadataRevision: number; parentId?: string | null; name?: string };
      return respondToWeb(
        await facade.restoreTrash(actor, params.id, {
          expectedMetadataRevision: payload.expectedMetadataRevision,
          parentId: payload.parentId,
          name: payload.name,
        }),
        error,
      );
    },
    {
      sessionAuth: true,
      params: CloudDriveTrashParamsSchema,
      body: RestoreCloudDriveTrashBodySchema,
      response: { 200: CloudDriveMutationResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "从回收站恢复",
        description:
          "恢复到原目录（或指定 parentId）；expectedMetadataRevision 取自回收站条目的 file.metadataRevision。",
      },
    },
  );
}
