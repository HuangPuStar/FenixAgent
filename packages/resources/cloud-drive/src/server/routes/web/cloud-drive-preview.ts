import type { AnyElysia } from "elysia";
import type { CloudDriveFacade } from "../../facades/cloud-drive-facade";
import {
  CloudDriveConversionJobResponseSchema,
  CloudDriveFileParamsSchema,
  CloudDriveMarkdownQuerySchema,
  CloudDriveMarkdownResponseSchema,
  CloudDrivePreviewPageParamsSchema,
  CloudDrivePreviewPageQuerySchema,
  CloudDrivePreviewResponseSchema,
} from "../../schemas/cloud-drive.schema";
import { actorFromStore } from "../dependencies";
import {
  respondToWeb,
  respondUnauthorized,
  statusForFailure,
  WEB_ERROR_RESPONSES,
  type WebRouteContext,
  webError,
} from "./cloud-drive-response";

/**
 * 云盘预览路由（markdown / 栅格清单 / 页图 / 重新转换）。
 *
 * 预览与其它读路径的差别只有一处：页图是二进制流，响应头本身就是契约，因此不套 `/web/*` 信封；
 * 其余三条仍返回 `{ success, data }`。所有端点都声明 `sessionAuth: true`，actor 只来自会话。
 */

/** 页图透传的头；其余（尤其 set-cookie 与上游 content-disposition）一律丢弃。 */
const PREVIEW_PAGE_HEADERS = ["content-type", "content-length", "etag", "last-modified"] as const;

/** 语义缓存的时长：页图按「版本 + 页号」固定，版本不变时内容不变。 */
const PREVIEW_PAGE_MAX_AGE_SECONDS = 300;

export function registerCloudDrivePreviewRoutes(app: AnyElysia, facade: CloudDriveFacade): void {
  app.get(
    "/cloud-drive/files/:id/markdown",
    async ({ store, params, query, request, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(
        await facade.getMarkdown(actor, params.id, { cursor: query.cursor || undefined }, request?.signal),
        error,
      );
    },
    {
      sessionAuth: true,
      params: CloudDriveFileParamsSchema,
      query: CloudDriveMarkdownQuerySchema,
      response: { 200: CloudDriveMarkdownResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "读取文件 markdown 预览",
        description:
          "返回转换产物的 markdown 一页（上游约 64KiB/页）。nextCursor 非空时继续请求同一端点取下一页；转换未完成返回 404 CLOUD_DRIVE_PREVIEW_NOT_READY，转换失败返回 422 CLOUD_DRIVE_PREVIEW_FAILED。",
      },
    },
  );

  app.get(
    "/cloud-drive/files/:id/preview",
    async ({ store, params, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(await facade.getPreview(actor, params.id), error);
    },
    {
      sessionAuth: true,
      params: CloudDriveFileParamsSchema,
      response: { 200: CloudDrivePreviewResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "获取文件栅格预览页清单",
        description:
          "返回可预览页数、页号与版本 ID；页图必须带上 versionId 请求。Office 文档缺少栅格转换依赖时上游返回 503，调用方应改用 markdown 预览。",
      },
    },
  );

  app.get(
    "/cloud-drive/files/:id/preview/pages/:page",
    async ({ store, params, query, request, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      const result = await facade.openPreviewPage(
        actor,
        params.id,
        { page: params.page, versionId: query.versionId || undefined },
        request.signal,
      );
      if (!result.ok) {
        return error(statusForFailure(result.error), webError(result.error.code, result.error.message));
      }
      const headers = new Headers();
      for (const name of PREVIEW_PAGE_HEADERS) {
        const value = result.data.response.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (!headers.has("content-type")) headers.set("content-type", "image/png");
      // 显式版本 → 可按版本缓存；用元数据补齐当前版本时 URL 不带版本，禁止缓存，避免换版本后命中旧图。
      headers.set(
        "cache-control",
        result.data.cacheable ? `private, max-age=${PREVIEW_PAGE_MAX_AGE_SECONDS}, immutable` : "no-store",
      );
      return new Response(result.data.response.body, { status: 200, headers });
    },
    {
      sessionAuth: true,
      params: CloudDrivePreviewPageParamsSchema,
      query: CloudDrivePreviewPageQuerySchema,
      detail: {
        tags: ["CloudDrive"],
        summary: "获取栅格预览页图",
        description:
          "流式返回 PNG 页图并透传 Content-Type / Content-Length。versionId 省略时使用文件当前版本；页号越界或版本不存在返回 404 CLOUD_DRIVE_PREVIEW_PAGE_NOT_FOUND。",
      },
    },
  );

  app.post(
    "/cloud-drive/files/:id/conversions",
    async ({ store, params, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(await facade.retryConversion(actor, params.id), error);
    },
    {
      sessionAuth: true,
      params: CloudDriveFileParamsSchema,
      response: { 200: CloudDriveConversionJobResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "重新请求文件转换",
        description:
          "为失败（或从未发起）的转换重新排队；正在转换返回 409 CLOUD_DRIVE_CONVERSION_IN_PROGRESS，已就绪返回 409 CLOUD_DRIVE_CONVERSION_NOT_NEEDED。任务进度只能轮询文件元数据。",
      },
    },
  );
}
