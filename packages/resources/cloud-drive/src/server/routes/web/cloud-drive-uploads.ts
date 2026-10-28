import { WebErrSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type { CloudDriveFacade } from "../../facades/cloud-drive-facade";
import {
  BeginCloudDriveUploadBodySchema,
  CloudDriveAbandonResponseSchema,
  CloudDriveUploadParamsSchema,
  CloudDriveUploadResponseSchema,
  CloudDriveUploadResultResponseSchema,
  CloudDriveUploadStatusResponseSchema,
} from "../../schemas/cloud-drive.schema";
import { actorFromStore } from "../dependencies";
import {
  respondToWeb,
  respondUnauthorized,
  statusForFailure,
  type WebRouteContext,
  webData,
  webError,
} from "./cloud-drive-response";

/** CloudDrive 的 HTTP 服务端硬上限是 64 MiB（`WithMaxRequestBodySize`）；超过它的分片必然被拒。 */
const MAX_UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024;

const ERROR_RESPONSES = {
  400: WebErrSchema,
  404: WebErrSchema,
  409: WebErrSchema,
  413: WebErrSchema,
  502: WebErrSchema,
  503: WebErrSchema,
} as const;

/**
 * 上传代理（TUS）的五个端点。
 *
 * 浏览器只与 Fenix 通信：`POST /uploads` 由本仓库生成 `idempotency_key` 并在 CloudDrive 预留会话，
 * 之后的分片与提交都经 `/uploads/:id` 转发。**master key 与 CloudDrive 的 `upload_url` 都不出服务端**，
 * 前端拿到的 `uploadId` 就是 Fenix 侧的唯一句柄；CloudDrive 按主体隔离该会话，跨用户拿到的 ID 会在
 * 上游按 `NOT_FOUND` 拒绝。
 *
 * 分片建议 4 MiB（见 `CLOUD_DRIVE_RECOMMENDED_CHUNK_BYTES`）：CloudDrive 单请求上限 64 MiB，宿主
 * 全站 body 上限 108 MiB，4 MiB 给重试与并发留足余量。
 */
export function registerCloudDriveUploadRoutes(app: AnyElysia, facade: CloudDriveFacade): void {
  app.post(
    "/cloud-drive/uploads",
    async ({ store, body, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      const payload = body as {
        fileId?: string;
        parentId?: string | null;
        name?: string;
        sizeBytes: number;
        contentType?: string;
      };
      return respondToWeb(
        await facade.beginUpload(actor, {
          fileId: payload.fileId,
          parentId: payload.parentId,
          name: payload.name,
          sizeBytes: payload.sizeBytes,
          contentType: payload.contentType,
        }),
        error,
      );
    },
    {
      sessionAuth: true,
      body: BeginCloudDriveUploadBodySchema,
      response: { 200: CloudDriveUploadResponseSchema, ...ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "创建上传会话",
        description:
          "为新建或覆盖写预留一次 TUS 上传。返回 uploadId（后续续传/提交的句柄）、fileId 与会话过期时间；幂等键由服务端生成。",
      },
    },
  );

  app.get(
    "/cloud-drive/uploads/:id",
    async ({ store, params, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(await facade.getUploadStatus(actor, params.id), error);
    },
    {
      sessionAuth: true,
      params: CloudDriveUploadParamsSchema,
      response: { 200: CloudDriveUploadStatusResponseSchema, ...ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "查询上传进度",
        description: "返回已接收字节数 offset 与预留总长 length；续传时必须把 offset 作为 Upload-Offset 发送。",
      },
    },
  );

  app.patch(
    "/cloud-drive/uploads/:id",
    async ({ store, params, request, error, set }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      const contentLength = request.headers.get("content-length");
      if (!isNonNegativeInteger(contentLength)) {
        // CloudDrive 明确拒绝 chunked transfer：先在这里给出 411，避免上游把缺失长度判成 INVALID_ARGUMENT。
        return error(411, webError("CLOUD_DRIVE_LENGTH_REQUIRED", "分片请求必须携带 Content-Length"));
      }
      const offsetHeader = request.headers.get("upload-offset");
      if (Number(contentLength) > MAX_UPLOAD_CHUNK_BYTES) {
        // 在把 64MiB 以上读进内存之前拒绝：CloudDrive 的上限比宿主 body 上限更小。
        return error(413, webError("CLOUD_DRIVE_PAYLOAD_TOO_LARGE", "单个分片不能超过 64MiB"));
      }
      if (!isNonNegativeInteger(offsetHeader)) {
        return error(400, webError("CLOUD_DRIVE_OFFSET_INVALID", "Upload-Offset 必须是非负整数"));
      }
      let chunk: Uint8Array<ArrayBuffer>;
      try {
        chunk = new Uint8Array(await request.arrayBuffer());
      } catch {
        return error(400, webError("CLOUD_DRIVE_CHUNK_UNREADABLE", "无法读取分片请求体"));
      }
      if (chunk.byteLength !== Number(contentLength)) {
        return error(400, webError("CLOUD_DRIVE_LENGTH_MISMATCH", "分片实际长度与 Content-Length 不一致"));
      }
      const result = await facade.uploadChunk(
        actor,
        params.id,
        { offset: Number(offsetHeader), chunk },
        request.signal,
      );
      if (!result.ok) {
        return error(statusForFailure(result.error), webError(result.error.code, result.error.message));
      }
      // 与 TUS 语义保持一致：进度同时放进响应头，便于前端不发额外 HEAD 就能续传。
      set.headers["Upload-Offset"] = String(result.data.offset);
      set.headers["Upload-Length"] = String(result.data.length);
      return webData(result.data);
    },
    {
      sessionAuth: true,
      // 原始分片必须保持字节不变：一旦被 Elysia 解析，request.arrayBuffer() 将拿不到 body。
      parse: "none",
      params: CloudDriveUploadParamsSchema,
      response: { 200: CloudDriveUploadStatusResponseSchema, ...ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "上传一个分片",
        description:
          "请求体是本片原始字节。必须携带 Content-Length 与 Upload-Offset；服务端固定使用 Content-Type: application/offset+octet-stream，并透传 TUS 的 Upload-Offset / Upload-Length 响应头。",
      },
    },
  );

  app.post(
    "/cloud-drive/uploads/:id/finalize",
    async ({ store, params, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(await facade.finalizeUpload(actor, params.id), error);
    },
    {
      sessionAuth: true,
      params: CloudDriveUploadParamsSchema,
      response: { 200: CloudDriveUploadResultResponseSchema, ...ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "提交上传",
        description: "在所有分片写完后提交；CloudDrive 通过原生校验后才生成新版本。重复提交是安全的。",
      },
    },
  );

  app.post(
    "/cloud-drive/uploads/:id/abandon",
    async ({ store, params, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(await facade.abandonUpload(actor, params.id), error);
    },
    {
      sessionAuth: true,
      params: CloudDriveUploadParamsSchema,
      response: { 200: CloudDriveAbandonResponseSchema, ...ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "放弃上传",
        description: "失败或取消时释放上传会话与预留配额；已有字节被接收后上游可能返回 409。",
      },
    },
  );
}

/** 非负整数字符串；用于 Content-Length / Upload-Offset 这类只能按十进制传输的头。 */
function isNonNegativeInteger(value: string | null): value is string {
  return value !== null && /^\d+$/.test(value);
}
