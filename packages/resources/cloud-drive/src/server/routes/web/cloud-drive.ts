import { type AnyElysia, Elysia } from "elysia";
import type { CloudDriveFacade } from "../../facades/cloud-drive-facade";
import {
  CloudDriveContentHeadersSchema,
  CloudDriveContentQuerySchema,
  CloudDriveFilePageResponseSchema,
  CloudDriveFileParamsSchema,
  CloudDriveFileResponseSchema,
  CloudDriveListFilesQuerySchema,
  CloudDriveMeResponseSchema,
  CloudDriveSearchResultPageResponseSchema,
  CloudDriveVersionPageResponseSchema,
  SearchCloudDriveBodySchema,
} from "../../schemas/cloud-drive.schema";
import { actorFromStore, type CloudDriveRouteDependencies } from "../dependencies";
import { registerCloudDriveMutationRoutes } from "./cloud-drive-mutations";
import {
  respondToWeb,
  respondUnauthorized,
  statusForFailure,
  WEB_ERROR_RESPONSES,
  type WebRouteContext,
  webError,
} from "./cloud-drive-response";
import { registerCloudDriveUploadRoutes } from "./cloud-drive-uploads";

/**
 * `/web/cloud-drive/*` 路由工厂（16 个端点）。
 *
 * 分工：本文件只做协议适配（参数校验、状态码、下载流的响应头透传），业务编排在 Facade，出站 HTTP
 * 在 client。所有端点都声明 `sessionAuth: true` 并从 `store.authContext` 投影 actor——请求体与查询串
 * **没有**用户标识字段，也就没有「客户端指定 subject」的入口。
 *
 * 端点为 kebab-case 且以资源为中心（`files` / `directories` / `trash` / `uploads`），非 CRUD 动作走
 * 子路径 POST（`.../:id/finalize`、`.../:id/abandon`、`.../:id/restore`）。
 */

/** 仅声明本模块处理函数会返回的错误状态；守卫自己的 401 不在此列（避免被响应 schema 校验）。 */
/** 下载响应透传的头部白名单；其余（尤其 set-cookie）一律丢弃。 */
const CONTENT_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "content-disposition",
  "etag",
  "accept-ranges",
  "cache-control",
] as const;

/** 单段字节区间；上游只支持 `bytes=start-` 与 `bytes=start-end`。 */
const RANGE_PATTERN = /^bytes=\d+-\d*$/;

/** `/web/cloud-drive/*` 路由工厂。 */
export function createWebCloudDriveRoutes(deps: CloudDriveRouteDependencies) {
  const app = new Elysia({ name: "web-cloud-drive" }).use(deps.authGuardPlugin);

  // 参数校验失败统一成 `/web/*` 信封；其余异常交回宿主全局处理器（日志、requestId、脱敏都在那里）。
  app.onError(({ code, set }: WebRouteContext) => {
    if (code === "VALIDATION" || code === "PARSE") {
      set.status = 400;
      return webError("VALIDATION_ERROR", "请求参数不合法");
    }
    return;
  });

  registerReadRoutes(app, deps.facade);
  registerCloudDriveMutationRoutes(app, deps.facade);
  registerCloudDriveUploadRoutes(app, deps.facade);
  return app;
}

/** 读路径：主体/配额、列表、元数据、版本、下载、搜索。 */
function registerReadRoutes(app: AnyElysia, facade: CloudDriveFacade): void {
  app.get(
    "/cloud-drive/me",
    async ({ store, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(await facade.me(actor), error);
    },
    {
      sessionAuth: true,
      response: { 200: CloudDriveMeResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "获取个人云盘主体与配额",
        description: "返回当前登录用户在 CloudDrive 的稳定主体标识与配额使用情况（上限 / 已用 / 预留）。",
      },
    },
  );

  app.get(
    "/cloud-drive/files",
    async ({ store, query, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(
        await facade.listFiles(actor, {
          parentId: query.parentId || undefined,
          cursor: query.cursor || undefined,
        }),
        error,
      );
    },
    {
      sessionAuth: true,
      query: CloudDriveListFilesQuerySchema,
      response: { 200: CloudDriveFilePageResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "列出目录内容",
        description: "按 parentId 列出当前用户的文件与目录，游标分页；省略 parentId 表示根目录。",
      },
    },
  );

  app.get(
    "/cloud-drive/files/:id",
    async ({ store, params, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(await facade.getFile(actor, params.id), error);
    },
    {
      sessionAuth: true,
      params: CloudDriveFileParamsSchema,
      response: { 200: CloudDriveFileResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "获取文件或目录元数据",
        description: "不存在或不属于当前用户时统一返回 404，避免把资源 ID 变成探测面。",
      },
    },
  );

  app.get(
    "/cloud-drive/files/:id/versions",
    async ({ store, params, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      return respondToWeb(await facade.listVersions(actor, params.id), error);
    },
    {
      sessionAuth: true,
      params: CloudDriveFileParamsSchema,
      response: { 200: CloudDriveVersionPageResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "列出文件历史版本",
        description: "返回该文件的版本列表（按 versionSeq 倒序），包含每个版本的大小与转换状态。",
      },
    },
  );

  app.get(
    "/cloud-drive/files/:id/content",
    async ({ store, params, query, request, error }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      const range = readSingleRange(request.headers.get("range"));
      if (range === null) return error(416, webError("RANGE_NOT_SATISFIABLE", "只支持单个 bytes 字节区间"));
      const result = await facade.openContent(
        actor,
        params.id,
        { versionId: firstValue(query.versionId), range },
        request.signal,
      );
      if (!result.ok) {
        return error(statusForFailure(result.error), webError(result.error.code, result.error.message));
      }
      const headers = new Headers();
      for (const name of CONTENT_HEADERS) {
        const value = result.data.response.headers.get(name);
        if (value) headers.set(name, value);
      }
      // 上游只给裸 `attachment`，文件名由 Fenix 补（RFC 5987 + ASCII fallback），前端另存才有名字。
      headers.set("content-disposition", attachmentDisposition(result.data.fileName));
      // 二进制响应不回 `/web/*` 信封：状态码、Content-Range 与字节流本身就是契约。
      return new Response(result.data.response.body, { status: result.data.response.status, headers });
    },
    {
      sessionAuth: true,
      params: CloudDriveFileParamsSchema,
      query: CloudDriveContentQuerySchema,
      headers: CloudDriveContentHeadersSchema,
      detail: {
        tags: ["CloudDrive"],
        summary: "下载文件内容",
        description:
          "流式返回原文，支持单段 Range（206 + Content-Range），并透传 Content-Type / Content-Length / Content-Disposition / ETag。",
      },
    },
  );

  app.post(
    "/cloud-drive/search",
    async ({ store, body, error, request }: WebRouteContext) => {
      const actor = actorFromStore(store);
      if (!actor) return respondUnauthorized(error);
      const payload = body as { query: string; cursor?: string; limit?: number };
      return respondToWeb(
        await facade.search(
          actor,
          {
            query: payload.query,
            cursor: payload.cursor,
            limit: payload.limit,
          },
          request?.signal,
        ),
        error,
      );
    },
    {
      sessionAuth: true,
      body: SearchCloudDriveBodySchema,
      response: { 200: CloudDriveSearchResultPageResponseSchema, ...WEB_ERROR_RESPONSES },
      detail: {
        tags: ["CloudDrive"],
        summary: "搜索个人云盘",
        description:
          "按关键词搜索当前用户的文件内容，按文件聚合命中片段并返回纯文本高亮区间。搜索是最终一致的，刚写入的文件可能短暂搜不到。",
      },
    },
  );
}

/** RFC 5987 的 ext-value：`encodeURIComponent` 不转义 `'()*`，这里逐个补上。 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * 下载响应头：`attachment` 语义不变，补充真实文件名。
 *
 * 同时给 ASCII fallback（老客户端）与 `filename*=UTF-8''...`（RFC 5987，中文/空格安全）；fallback 里的
 * 引号与反斜杠会被替换，避免构造出可截断的 header 值。
 */
function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

/** Elysia 的 query 值可能是数组；只取第一个字符串。 */
function firstValue(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string");
    return typeof first === "string" ? first || undefined : undefined;
  }
  return;
}

/**
 * 校验 Range：缺省返回 undefined；非法（多段、后缀、单位错误）返回 null。
 *
 * 上游同样只接受单段 `bytes=start-*`，这里提前拒绝可以给前端明确的 416，而不是让上游的
 * `INVALID_ARGUMENT` 落到「其余 → 502」。
 */
function readSingleRange(header: string | null): string | undefined | null {
  if (!header) return;
  const value = header.trim();
  return RANGE_PATTERN.test(value) ? value : null;
}
