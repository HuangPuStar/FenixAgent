/**
 * knowledge-bases.ts — 知识库域 API 模块
 *
 * 封装知识库的 CRUD 及资源管理操作，统一通过 request() 与后端 /web/knowledgeBases 通信。
 * 所有方法严格遵循 RESTful 风格。
 */

import { ApiError, request } from "@fenix/web-runtime/api/request";
import type {
  KnowledgeBaseCreateBody,
  KnowledgeBaseDetail,
  KnowledgeBaseInfo,
  KnowledgeBaseListResponse,
  KnowledgeFormOptions,
  KnowledgeResourceInfo,
  KnowledgeSearchBody,
  KnowledgeSearchResultData,
  KnowledgeUploadResponse,
  RerankModelOption,
  UnassociatedKnowledgeBase,
} from "../types/knowledge";

/**
 * 创建知识库请求体由 `types/knowledge` 唯一持有，这里只 re-export。
 *
 * 收敛前本文件原地再声明了一份逐字相同的副本（含各自的字段注释），页面侧还有第三份内联副本；
 * 三处字段、可选性、类型完全一致，因此合并成一份不会放宽任何类型。类型定义集中在 types 目录，
 * 也让「请求体形状」只有一个改动点。
 */
export type { KnowledgeBaseCreateBody };

/** 更新知识库请求体（部分字段可选） */
export type KnowledgeBaseUpdateBody = Partial<KnowledgeBaseCreateBody>;

export const kbApi = {
  /** 查询知识库列表 */
  list: () => request<KnowledgeBaseListResponse>("/web/knowledgeBases", { method: "GET" }),

  /** 根据 ID 获取单个知识库详情 */
  get: (params: { id: string }) => request<KnowledgeBaseDetail>("/web/knowledgeBases/:id", { method: "GET", params }),

  /** 创建新的知识库 */
  create: (body: KnowledgeBaseCreateBody) =>
    request<KnowledgeBaseInfo>("/web/knowledgeBases", { method: "POST", body }),

  /** 获取创建知识库表单所需的可选项（嵌入模型、分块方法、pipeline）。 */
  getFormOptions: () => request<KnowledgeFormOptions>("/web/knowledgeBases/form-options", { method: "GET" }),

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

// ============================================================
// 资源文件内容读取（预览用）
// ============================================================
//
// 这三个函数供预览组件读取资源文件本体，方法是**模块级导出而不是 `kbApi` 的方法**：`kbApi` 已经
// 出了包 `./web` 出口（跨包消费方是 agent-config），把只有包内预览组件使用的读取适配挂上去会把
// 私有能力写进对外契约（§1.2「导出面按包外真实消费点收敛」）。它们只在包内经相对路径引用。

/**
 * 读取资源文件的文本内容（Markdown / 文本 / HTML / CSV 预览）。
 *
 * 为什么不走 `request()`：预览端点的成功响应体是文件本体（`text/markdown`、`text/csv` 等），而
 * `request()` 对非 JSON 响应体会先按 JSON 试探解析，读到的文本在这一步被消费掉并归一为
 * `SERVER_ERROR`，拿不到内容。失败路径仍接回统一层：非 2xx 一律抛 `ApiError`。
 *
 * 抛错即契约：调用方必须接住（`useRequest` 的 onError 或 try/catch）。本函数不吞错、不弹提示。
 */
export async function fetchResourceFileText(params: { kbId: string; resourceId: string }): Promise<string> {
  const response = await fetch(kbApi.getFileUrl(params), { credentials: "include" });
  if (!response.ok) throw await buildResourceReadError(response);
  return response.text();
}

/**
 * 读取资源文件的二进制内容（xlsx 表格解析、docx 客户端转换）。失败语义与
 * `fetchResourceFileText` 相同；`request()` 读不到字节的理由见该函数说明。
 */
export async function fetchResourceFileBinary(params: { kbId: string; resourceId: string }): Promise<ArrayBuffer> {
  const response = await fetch(kbApi.getFileUrl(params), { credentials: "include" });
  if (!response.ok) throw await buildResourceReadError(response);
  return response.arrayBuffer();
}

/**
 * 探测 Office 资源的服务端 PDF 转换是否可用（预览优先用转换后的 PDF）。
 *
 * 未转换/非 Office 资源返回 `false` 是**正常分支**而不是错误——调用方据此降级到客户端转换或下载，
 * 因此这里不对非 2xx 抛错；只有网络层失败才会抛出。
 */
export async function isResourcePdfPreviewAvailable(params: { kbId: string; resourceId: string }): Promise<boolean> {
  const response = await fetch(kbApi.getPdfUrl(params), { credentials: "include" });
  return response.ok && (response.headers.get("content-type") ?? "").includes("pdf");
}

/**
 * 把资源文件读取失败归一为统一错误。
 *
 * 错误体是 `/web/knowledgeBases/*` 的 `{ success: false, error: { code, message } }` 信封；被网关或
 * 代理拦截时可能返回 HTML，那时解析会抛错。解析失败不掩盖原始失败：记下响应状态与解析异常作为
 * 诊断上下文，再以状态码兜底（401/403 归 UNAUTHORIZED，其余归 SERVER_ERROR），与 `request()` 层
 * 「凭据失效不误判成服务异常」的口径一致。
 */
async function buildResourceReadError(response: Response): Promise<ApiError> {
  try {
    const payload = (await response.json()) as { error?: { code?: string; message?: string } };
    if (payload.error?.code) {
      return new ApiError(payload.error.message ?? `请求失败 (${response.status})`, payload.error.code);
    }
  } catch (err) {
    console.error(`[knowledge] 资源文件读取失败响应无法按错误信封解析 (${response.status})`, err);
  }
  const fallbackCode = response.status === 401 || response.status === 403 ? "UNAUTHORIZED" : "SERVER_ERROR";
  return new ApiError(`请求失败 (${response.status})`, fallbackCode);
}
