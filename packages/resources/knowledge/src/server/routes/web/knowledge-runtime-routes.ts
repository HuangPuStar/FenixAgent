/**
 * `/web/knowledgeBases/:id/search` 与 `/web/knowledgeBases/:id/graph*` 控制台端点：检索测试与知识图谱。
 *
 * 本层只做协议：请求体校验与响应映射；知识库解析、凭据与 provider 调用在
 * `../../facades/knowledge-runtime-facade`。错误分类由门面的 `kind` 决定，
 * 因此这里不再按错误文案猜状态码。
 */

import { WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { knowledgeRuntimeFacade } from "../../facades/knowledge-runtime-facade";
import { KnowledgeSearchBodySchema, KnowledgeSearchResponseSchema } from "../../schemas/knowledge.schema";
import type { KnowledgeRouteDependencies, SessionAuthContext } from "../dependencies";
import { respondToWeb } from "./knowledge-web-response";

/** `/web/knowledgeBases/:id/search|graph*` 路由工厂；守卫由宿主注入（理由见 `../dependencies`）。 */
export function createWebKnowledgeRuntimeRoutes(deps: KnowledgeRouteDependencies) {
  const app = new Elysia({ name: "web-knowledge-bases-runtime" }).use(deps.authGuardPlugin).model({
    "knowledge-search-body": KnowledgeSearchBodySchema,
    "knowledge-search-response": KnowledgeSearchResponseSchema,
  });

  app.post(
    "/knowledgeBases/:id/search",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
    async ({ store, params, body, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const payload = body as {
        query: string;
        similarityThreshold?: number;
        vectorSimilarityWeight?: number;
        rerankId?: string | null;
        keyword?: boolean;
        highlight?: boolean;
        pageSize?: number;
        page?: number;
        topK?: number;
        useKg?: boolean;
        crossLanguages?: string[];
        metaDataFilter?: import("../../services/knowledge-provider/types").MetaDataFilter;
      };

      // topK 取一个合理上限（与 RAGFlow 默认 1024 一致），检索测试不暴露此参数
      const result = await knowledgeRuntimeFacade.search(actor, params.id, {
        query: payload.query,
        topK: payload.topK ?? 1024,
        similarityThreshold: payload.similarityThreshold,
        vectorSimilarityWeight: payload.vectorSimilarityWeight,
        rerankId: payload.rerankId,
        keyword: payload.keyword,
        highlight: payload.highlight,
        pageSize: payload.pageSize,
        page: payload.page,
        useKg: payload.useKg,
        crossLanguages: payload.crossLanguages,
        metaDataFilter: payload.metaDataFilter,
      });
      return respondToWeb(result, error);
    },
    {
      sessionAuth: true,
      body: "knowledge-search-body",
      response: {
        200: "knowledge-search-response",
        404: WebErrSchema,
        502: WebErrSchema,
      },
      detail: {
        tags: ["Knowledge"],
        summary: "知识库检索测试",
        description:
          "对指定知识库执行检索测试，返回命中的 chunk 列表（含三种相似度分、高亮）、总命中数与文档维度聚合。支持相似度阈值、向量/全文权重、rerank 模型、关键词匹配等核心参数。",
      },
    },
  );

  // ============================================================
  // 知识图谱
  // ============================================================

  app.post(
    "/knowledgeBases/:id/graph/generate",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ store, params, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      return respondToWeb(await knowledgeRuntimeFacade.generateGraph(actor, params.id), error);
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Knowledge"],
        summary: "生成知识图谱",
        description: "触发知识库的 GraphRAG 知识图谱生成流水线。",
      },
    },
  );

  app.get(
    "/knowledgeBases/:id/graph",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ store, params, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      return respondToWeb(await knowledgeRuntimeFacade.getGraph(actor, params.id), error);
    },
    {
      sessionAuth: true,
      detail: { tags: ["Knowledge"], summary: "获取知识图谱", description: "获取知识库的知识图谱数据（节点 + 边）。" },
    },
  );

  app.delete(
    "/knowledgeBases/:id/graph",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ store, params, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      return respondToWeb(await knowledgeRuntimeFacade.deleteGraph(actor, params.id), error);
    },
    {
      sessionAuth: true,
      detail: { tags: ["Knowledge"], summary: "删除知识图谱", description: "删除知识库的知识图谱数据。" },
    },
  );

  app.get(
    "/knowledgeBases/:id/graph/progress",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ store, params, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      return respondToWeb(await knowledgeRuntimeFacade.pollGraphProgress(actor, params.id), error);
    },
    {
      sessionAuth: true,
      detail: { tags: ["Knowledge"], summary: "查询图谱生成进度", description: "轮询知识图谱生成任务进度。" },
    },
  );

  return app;
}
