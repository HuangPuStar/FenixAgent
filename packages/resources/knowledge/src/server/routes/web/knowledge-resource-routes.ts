/**
 * `/web/knowledgeBases/:id/resources*` 控制台端点：资源上传/导入、列表刷新、文件预览、启停、重解析、切片。
 *
 * 本层只做协议：解析表单与参数、映射响应；归属判定（先资源、后知识库）、凭据解析与 provider 调用都在
 * `../../facades/knowledge-resource-facade`。因此这里不再出现 `authCtx.organizationId` / `authCtx.userId`，
 * 也不再有「漏调一次前置归属查询就失去校验」的可能。
 */

import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { knowledgeResourceFacade } from "../../facades/knowledge-resource-facade";
import {
  ImportKnowledgeUrlRequestSchema,
  ImportKnowledgeUrlResponseSchema,
  KnowledgeResourceListResponseSchema,
  UploadKnowledgeResourcesResponseSchema,
} from "../../schemas/knowledge.schema";
import type { KnowledgeRouteDependencies, SessionAuthContext } from "../dependencies";
import { convertToPdf, isOfficeFile, localFileResponse, pdfResponse } from "./knowledge-resource-preview";
import { respondToWeb, webData } from "./knowledge-web-response";

/** `/web/knowledgeBases/:id/resources*` 路由工厂；守卫由宿主注入（理由见 `../dependencies`）。 */
export function createWebKnowledgeResourceRoutes(deps: KnowledgeRouteDependencies) {
  const app = new Elysia({ name: "web-knowledge-bases-resources" }).use(deps.authGuardPlugin).model({
    "knowledge-resource-list": KnowledgeResourceListResponseSchema,
    "upload-knowledge-resources-response": UploadKnowledgeResourcesResponseSchema,
    "import-knowledge-url-request": ImportKnowledgeUrlRequestSchema,
    "import-knowledge-url-response": ImportKnowledgeUrlResponseSchema,
    "delete-knowledge-resource-response": WebOkSchema(z.null()).describe("删除知识资源后的成功响应。"),
  });

  app.post(
    "/knowledgeBases/:id/resources/upload",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 multipart/response 组合下类型推断不稳定
    async ({ store, params, request, query, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const overwrite = query.overwrite === "true" || query.overwrite === "1";
      let files: File[];
      try {
        const form = await request.formData();
        files = Array.from(form.getAll("files")).filter(
          (entry: unknown): entry is globalThis.File => entry instanceof globalThis.File,
        );
      } catch (err) {
        // 表单本身不可解析时的既有口径：400 `VALIDATION_ERROR`，文案取异常消息
        console.error(err);
        return error(400, {
          success: false,
          error: { code: "VALIDATION_ERROR", message: (err as Error).message },
        });
      }
      const result = await knowledgeResourceFacade.upload(actor, params.id, files, { overwrite });
      if (!result.ok) return respondToWeb(result, error);
      // 响应形状由协议层决定：门面给的是本次处理后的资源 DTO 列表
      return webData({ items: result.data });
    },
    {
      sessionAuth: true,
      response: {
        200: "upload-knowledge-resources-response",
        400: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Knowledge"],
        summary: "上传知识资源",
        description: "向指定知识库上传一个或多个文件资源，并返回本次处理后的资源列表。",
      },
    },
  );

  app.post(
    "/knowledgeBases/:id/resources/url",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
    async ({ store, params, body, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const payload = body as { url: string; sourceName?: string };
      if (!payload.url || typeof payload.url !== "string") {
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "url 为必填字段" } });
      }
      const result = await knowledgeResourceFacade.importFromUrl(actor, params.id, {
        url: payload.url,
        sourceName: payload.sourceName,
      });
      if (!result.ok) return respondToWeb(result, error);
      // 远端失败不抛错：资源以 error 状态落库返回，协议层按既有口径映射 502，响应体是资源 DTO 本身
      if (result.data.status === "error") return error(502, result.data);
      return webData(result.data);
    },
    {
      sessionAuth: true,
      body: "import-knowledge-url-request",
      response: {
        200: "import-knowledge-url-response",
        201: "import-knowledge-url-response",
        400: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Knowledge"],
        summary: "通过 URL 导入资源",
        description: "从指定 URL 拉取内容并导入到知识库，返回创建后的资源记录。",
      },
    },
  );

  app.get(
    "/knowledgeBases/:id/resources",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store, params, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      return respondToWeb(await knowledgeResourceFacade.list(actor, params.id), error);
    },
    {
      sessionAuth: true,
      response: {
        200: "knowledge-resource-list",
        404: WebErrSchema,
      },
      detail: {
        tags: ["Knowledge"],
        summary: "获取知识资源列表",
        description: "返回指定知识库下的全部知识资源记录。",
      },
    },
  );

  app.get(
    "/knowledgeBases/:id/resources/:resourceId/file",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store, params, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const preview = await knowledgeResourceFacade.resolveFilePreview(actor, params.id, params.resourceId);
      if (!preview.ok) return respondToWeb(preview, error);

      // url 类型：重定向到原始 URL
      if (preview.data.kind === "redirect") {
        return new Response(null, { status: 302, headers: { Location: preview.data.url } });
      }

      // 远端导入的资源：直接回传 provider 下载到的内容
      if (preview.data.kind === "remote") {
        return new Response(preview.data.content, {
          headers: {
            "Content-Type": preview.data.contentType,
            "Content-Disposition": `inline; filename="${encodeURIComponent(preview.data.fileName)}"`,
          },
        });
      }

      // upload 类型：本地文件必须存在且是普通文件
      try {
        const fileInfo = await stat(preview.data.path);
        if (!fileInfo.isFile()) {
          return error(404, { success: false, error: { code: "FILE_NOT_FOUND", message: "源文件不存在" } });
        }
        return localFileResponse(preview.data.path, preview.data.fileName, fileInfo.size);
      } catch (err) {
        console.error("Failed to serve knowledge resource file", err);
        return error(404, { success: false, error: { code: "FILE_NOT_FOUND", message: "源文件不存在或无法读取" } });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Knowledge"],
        summary: "获取知识资源文件",
        description: "返回知识资源的源文件内容，用于前端预览（PDF、图片、Markdown 等）。仅 upload 类型资源支持。",
      },
    },
  );

  app.get(
    "/knowledgeBases/:id/resources/:resourceId/pdf",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store, params, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const source = await knowledgeResourceFacade.resolvePdfSource(actor, params.id, params.resourceId);
      if (!source.ok) return respondToWeb(source, error);

      if (!isOfficeFile(source.data.fileName)) {
        return error(400, {
          success: false,
          error: { code: "NOT_OFFICE_FILE", message: "该资源不是 Office 文档，无需转换" },
        });
      }

      try {
        // 验证源文件存在
        const srcStat = await stat(source.data.path);
        if (!srcStat.isFile()) {
          return error(404, { success: false, error: { code: "FILE_NOT_FOUND", message: "源文件不存在" } });
        }

        // 转换为 PDF
        const pdfPath = await convertToPdf(source.data.path, source.data.fileName, params.resourceId);
        if (!pdfPath) {
          return error(501, {
            success: false,
            error: {
              code: "CONVERSION_UNAVAILABLE",
              message: "PDF 转换服务不可用（需要 LibreOffice），请下载后本地查看",
            },
          });
        }

        const pdfStat = await stat(pdfPath);
        // 沿用迁移前的替换表达式：小写扩展名只在小写的源文件名上命中
        const pdfName = source.data.fileName.replace(extname(source.data.fileName).toLowerCase(), ".pdf");
        return pdfResponse(pdfPath, pdfName, pdfStat.size);
      } catch (err) {
        console.error("Failed to convert Office file to PDF", err);
        return error(500, { success: false, error: { code: "CONVERSION_ERROR", message: "PDF 转换失败" } });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Knowledge"],
        summary: "将 Office 资源转换为 PDF",
        description: "将 Word/Excel/PPT 等 Office 文档转换为 PDF 并返回，用于前端预览。需要服务端安装 LibreOffice。",
      },
    },
  );

  app.patch(
    "/knowledgeBases/:id/resources/:resourceId/enabled",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store, params, body, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const enabled = body?.enabled === true || body?.enabled === "true" || body?.enabled === 1;
      return respondToWeb(
        await knowledgeResourceFacade.setEnabled(actor, params.id, params.resourceId, enabled),
        error,
      );
    },
    {
      sessionAuth: true,
      response: { 200: WebOkSchema(z.object({ enabled: z.boolean() })), 400: WebErrSchema, 404: WebErrSchema },
      detail: {
        tags: ["Knowledge"],
        summary: "启用/禁用知识资源",
        description: "切换单个文档的启用状态。",
      },
    },
  );

  app.post(
    "/knowledgeBases/:id/resources/:resourceId/reparse",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store, params, body, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const deleteOld = body?.delete === true;
      return respondToWeb(
        await knowledgeResourceFacade.reparse(actor, params.id, params.resourceId, { deleteOld }),
        error,
      );
    },
    {
      sessionAuth: true,
      response: { 200: WebOkSchema(z.null()), 400: WebErrSchema, 404: WebErrSchema },
      detail: {
        tags: ["Knowledge"],
        summary: "触发文档重新解析",
        description: "触发 RagFlow 对指定文档执行重新解析（异步），成功返回后由前端轮询进度。",
      },
    },
  );

  // ── 分页查询资源切片列表 ──
  app.get(
    "/knowledgeBases/:id/resources/:resourceId/chunks",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store, params, query, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const page = Math.max(1, Number(query?.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(query?.pageSize) || 20));
      const keyword = query?.keyword?.trim() || undefined;
      return respondToWeb(
        await knowledgeResourceFacade.listChunks(actor, params.id, params.resourceId, { page, pageSize, keyword }),
        error,
      );
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Knowledge"],
        summary: "分页获取资源切片列表",
        description: "根据知识库 ID 和资源 ID 分页拉取切片列表，支持按关键词搜索。",
      },
    },
  );

  // ── 切换单个切片的启用/禁用状态 ──
  app.patch(
    "/knowledgeBases/:id/resources/:resourceId/chunks/:chunkId/enabled",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store, params, body, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const enabled = Boolean(body?.enabled);
      return respondToWeb(
        await knowledgeResourceFacade.setChunkEnabled(actor, params.id, params.resourceId, params.chunkId, enabled),
        error,
      );
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Knowledge"],
        summary: "切换单个切片的启用/禁用状态",
        description: "调用 RAGFlow PATCH 接口，切换指定切片的 available 状态。",
      },
    },
  );

  app.delete(
    "/knowledgeBases/:id/resources/:resourceId",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store, params, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      return respondToWeb(await knowledgeResourceFacade.remove(actor, params.id, params.resourceId), error);
    },
    {
      sessionAuth: true,
      response: {
        200: "delete-knowledge-resource-response",
        400: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Knowledge"],
        summary: "删除知识资源",
        description: "删除指定知识库下的单个资源记录及其远端资源。",
      },
    },
  );

  return app;
}
