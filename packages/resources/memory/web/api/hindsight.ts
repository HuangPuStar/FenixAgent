import { request, unwrap } from "@/src/api/request";
import type {
  BankStats,
  DocumentChunk,
  DocumentsResponse,
  EntityGraphResponse,
  EntityItem,
  GraphApiData,
  HindsightStatus,
  MemoriesResponse,
  MemoryDetail,
  MentalModel,
  RecallResponse,
  ReflectResponse,
} from "../pages/hindsight/types";

const BASE = "/web/hindsight";

/** 复用前端公共请求边界，并将失败响应统一转换为 ApiError。 */
async function apiRequest<T>(path: string, options?: Parameters<typeof request>[1]): Promise<T> {
  return unwrap(request<T>(`${BASE}${path}`, options));
}

export const hindsightApi = {
  /** 获取 Hindsight 状态 + bankId */
  getStatus: () => apiRequest<HindsightStatus>("/status"),

  /** 列出内存 */
  listMemories: (params?: { type?: string; q?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.type) qs.set("type", params.type);
    if (params?.q) qs.set("q", params.q);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    return apiRequest<MemoriesResponse>(`/memories?${qs.toString()}`);
  },

  /** 获取内存详情 */
  getMemory: (id: string) => apiRequest<MemoryDetail>(`/memories/${encodeURIComponent(id)}`),

  /** 删除内存 */
  deleteMemory: (id: string) => apiRequest<unknown>(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Recall 搜索 */
  recall: (params: { query: string; types?: string[]; max_tokens?: number }) =>
    apiRequest<RecallResponse>("/recall", {
      method: "POST",
      body: params,
    }),

  /** Reflect 反思 */
  reflect: (params: { query: string; max_tokens?: number }) =>
    apiRequest<ReflectResponse>("/reflect", {
      method: "POST",
      body: params,
    }),

  /** Retain 存储 */
  retain: (params: { items: Array<{ content: string; context?: string; tags?: string[] }> }) =>
    apiRequest<{ message?: string }>("/memories", {
      method: "POST",
      body: params,
    }),

  /** 获取内存图谱数据（用于 Constellation/Graph/Timeline 视图） */
  getGraph: (params: {
    type: string;
    limit?: number;
    q?: string;
    tags?: string[];
    document_id?: string;
    chunk_id?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params.type) qs.set("type", params.type);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.q) qs.set("q", params.q);
    if (params.tags) qs.set("tags", params.tags.join(","));
    if (params.document_id) qs.set("document_id", params.document_id);
    if (params.chunk_id) qs.set("chunk_id", params.chunk_id);
    return apiRequest<GraphApiData>(`/graph?${qs.toString()}`);
  },

  /** 获取 Bank 统计信息（整合状态等） */
  getBankStats: () => apiRequest<BankStats>("/bank-stats"),

  /** 列出文档 */
  listDocuments: (params?: { q?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    return apiRequest<DocumentsResponse>(`/documents?${qs.toString()}`);
  },

  /** 上传文档（multipart/form-data，Content-Type 由公共 request 自动处理） */
  uploadDocument: (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return apiRequest<{ document_id: string }>("/documents", {
      method: "POST",
      body: formData,
    });
  },

  /** 删除文档 */
  deleteDocument: (id: string) => apiRequest<unknown>(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 获取文档分块列表 */
  getDocumentChunks: (id: string) =>
    apiRequest<{ items: DocumentChunk[] }>(`/documents/${encodeURIComponent(id)}/chunks`),

  /** 列出心理模型 */
  listMentalModels: () => apiRequest<{ items: MentalModel[] }>("/mental-models"),

  /** 获取单个心理模型详情 */
  getMentalModel: (id: string) => apiRequest<MentalModel>(`/mental-models/${encodeURIComponent(id)}`),

  /** 删除心理模型 */
  deleteMentalModel: (id: string) =>
    apiRequest<unknown>(`/mental-models/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /** 列出实体 */
  listEntities: (params?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    return apiRequest<{ items: EntityItem[]; total: number }>(`/entities?${qs.toString()}`);
  },

  /** 获取单个实体详情 */
  getEntity: (id: string) => apiRequest<EntityItem>(`/entities/${encodeURIComponent(id)}`),

  /** 获取实体共现图谱 */
  getEntityGraph: (params?: { limit?: number; min_count?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.min_count !== undefined) qs.set("min_count", String(params.min_count));
    return apiRequest<EntityGraphResponse>(`/entities/graph?${qs.toString()}`);
  },
};
