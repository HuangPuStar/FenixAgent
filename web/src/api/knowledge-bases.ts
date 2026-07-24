/**
 * knowledge-bases.ts — 知识库域 API 模块
 *
 * 封装知识库的 CRUD 及资源管理操作，统一通过 request() 与后端 /web/knowledgeBases 通信。
 * 所有方法严格遵循 RESTful 风格。
 */

import type {
  KnowledgeBaseDetail,
  KnowledgeBaseInfo,
  KnowledgeBaseListResponse,
  KnowledgeFormOptions,
  KnowledgeParseMethod,
  KnowledgeResourceInfo,
  KnowledgeSearchBody,
  KnowledgeSearchResultData,
  KnowledgeUploadResponse,
  RerankModelOption,
  UnassociatedKnowledgeBase,
} from "../types/knowledge";
import { request } from "./request";

/** 创建知识库请求体 */
export interface KnowledgeBaseCreateBody {
  name: string;
  slug?: string;
  description?: string;
  /** 嵌入模型名；创建后不可改 */
  embeddingModel?: string | null;
  /** 解析方法；创建后不可改 */
  parseMethod?: KnowledgeParseMethod | null;
  /** 自定义解析 pipeline ID；仅 parseMethod=pipeline 时生效 */
  pipelineId?: string | null;
  /** 内置分块方法 parser_id；仅 parseMethod=builtin 时生效 */
  chunkMethod?: string | null;
  /** 知识库层级：global / org / user */
}

/** 更新知识库请求体（部分字段可选） */
export type KnowledgeBaseUpdateBody = Partial<KnowledgeBaseCreateBody>;

export const kbApi = {
  /** 查询知识库列表（三级分组：global / org / personal） */
  list: () => request<KnowledgeBaseListResponse>("/web/knowledgeBases", { method: "GET" }),

  /** 根据 ID 获取单个知识库详情 */
  get: (params: { id: string }) => request<KnowledgeBaseDetail>("/web/knowledgeBases/:id", { method: "GET", params }),

  /** 创建新的知识库 */
  create: (body: KnowledgeBaseCreateBody) =>
    request<KnowledgeBaseInfo>("/web/knowledgeBases", { method: "POST", body }),

  /** 获取创建知识库表单所需的可选项（嵌入模型、分块方法、pipeline）。keySource 用于按层级获取对应租户的模型列表。 */
  getFormOptions: (keySource?: string) =>
    request<KnowledgeFormOptions>("/web/knowledgeBases/form-options", {
      method: "GET",
      query: keySource ? { keySource } : undefined,
    }),

  /** 更新已有知识库 */
  update: (params: { id: string }, body: KnowledgeBaseUpdateBody) =>
    request<KnowledgeBaseInfo>("/web/knowledgeBases/:id", { method: "PATCH", params, body }),

  /** 删除知识库 */
  del: (params: { id: string }) => request<void>("/web/knowledgeBases/:id", { method: "DELETE", params }),

  /** 上传资源文件到知识库（FormData 格式），返回解析后的资源项列表 */
  uploadResources: (params: { id: string; overwrite?: boolean }, formData: FormData) =>
    request<KnowledgeUploadResponse>("/web/knowledgeBases/:id/resources/upload", {
      method: "POST",
      params: { id: params.id },
      query: params.overwrite ? { overwrite: "true" } : undefined,
      body: formData,
      timeout: 300_000, // 大文件上传 + RAGFlow 中转可能耗时较长
    }),

  /** 通过 URL 导入在线资源到知识库 */
  importUrl: (params: { id: string }, body: { url: string }) =>
    request<KnowledgeResourceInfo>("/web/knowledgeBases/:id/resources/url", {
      method: "POST",
      params,
      body,
    }),

  /** 查询知识库内的资源列表（后端返回普通数组，无分页） */
  listResources: (params: { id: string }, query?: { page?: number; pageSize?: number }) =>
    request<KnowledgeResourceInfo[]>("/web/knowledgeBases/:id/resources", {
      method: "GET",
      params,
      query,
    }),

  /** 删除知识库内的指定资源 */
  deleteResource: (params: { kbId: string; resourceId: string }) =>
    request<void>("/web/knowledgeBases/:kbId/resources/:resourceId", {
      method: "DELETE",
      params,
    }),

  /** 切换资源的启用/禁用状态 */
  toggleResourceEnabled: (params: { kbId: string; resourceId: string }, body: { enabled: boolean }) =>
    request<{ enabled: boolean }>("/web/knowledgeBases/:kbId/resources/:resourceId/enabled", {
      method: "PATCH",
      params,
      body,
    }),

  /** 触发文档重新解析（RAGFlow ingest） */
  reparseResource: (params: { kbId: string; resourceId: string }, body: { delete: boolean }) =>
    request<null>("/web/knowledgeBases/:kbId/resources/:resourceId/reparse", {
      method: "POST",
      params,
      body,
    }),

  /** 分页获取资源切片列表 */
  listChunks: (
    params: { kbId: string; resourceId: string },
    query?: { page?: number; pageSize?: number; keyword?: string },
  ) =>
    request<import("../types/knowledge").KnowledgeChunkListResponse>(
      "/web/knowledgeBases/:kbId/resources/:resourceId/chunks",
      { method: "GET", params, query },
    ),

  /** 切换单个切片的启用/禁用状态 */
  switchChunk: (params: { kbId: string; resourceId: string; chunkId: string }, body: { enabled: boolean }) =>
    request<{ enabled: boolean }>("/web/knowledgeBases/:kbId/resources/:resourceId/chunks/:chunkId/enabled", {
      method: "PATCH",
      params,
      body,
    }),

  /** 构造资源文件的预览/下载 URL（upload 类型资源） */
  getFileUrl: (params: { kbId: string; resourceId: string }) =>
    `/web/knowledgeBases/${encodeURIComponent(params.kbId)}/resources/${encodeURIComponent(params.resourceId)}/file`,

  /** 构造 Office 资源 PDF 转换预览 URL */
  getPdfUrl: (params: { kbId: string; resourceId: string }) =>
    `/web/knowledgeBases/${encodeURIComponent(params.kbId)}/resources/${encodeURIComponent(params.resourceId)}/pdf`,

  /** 检索测试：对指定知识库执行检索，返回命中的 chunk 列表与文档聚合 */
  search: (params: { id: string }, body: KnowledgeSearchBody) =>
    request<KnowledgeSearchResultData>("/web/knowledgeBases/:id/search", {
      method: "POST",
      params,
      body,
    }),

  /** 获取检索测试可用的 rerank 重排序模型列表 */
  listRerankModels: () => request<RerankModelOption[]>("/web/knowledgeBases/rerank-models", { method: "GET" }),

  /** 列出未关联的 RAGFlow 知识库 */
  listUnassociated: () =>
    request<UnassociatedKnowledgeBase[]>("/web/knowledgeBases", {
      method: "POST",
      body: { action: "list-unassociated" },
    }),

  /** 导入 RAGFlow 知识库到本地 */
  import: (remoteId: string, name: string) =>
    request<KnowledgeBaseInfo>("/web/knowledgeBases", {
      method: "POST",
      body: { action: "import", remoteId, name },
    }),

  // ============================================================
  // 知识图谱
  // ============================================================

  /** 生成知识图谱（触发后台 GraphRAG 流水线） */
  generateGraph: (params: { id: string }) =>
    request<null>("/web/knowledgeBases/:id/graph/generate", { method: "POST", params }),

  /** 获取知识图谱数据 */
  getGraph: (params: { id: string }) =>
    request<import("../types/knowledge").KnowledgeGraphData | null>("/web/knowledgeBases/:id/graph", {
      method: "GET",
      params,
    }),

  /** 删除知识图谱 */
  deleteGraph: (params: { id: string }) => request<null>("/web/knowledgeBases/:id/graph", { method: "DELETE", params }),

  /** 轮询知识图谱生成进度 */
  getGraphProgress: (params: { id: string }) =>
    request<import("../types/knowledge").KnowledgeGraphProgress>("/web/knowledgeBases/:id/graph/progress", {
      method: "GET",
      params,
    }),
};
