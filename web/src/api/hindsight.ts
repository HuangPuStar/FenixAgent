import type {
  DocumentsResponse,
  EntityGraphResponse,
  EntityItem,
  HindsightStatus,
  MemoriesResponse,
  MemoryDetail,
  MentalModel,
  RecallResponse,
  ReflectResponse,
} from "../pages/hindsight/types";

const BASE = "/web/hindsight";

/** 通用 fetch 封装，统一错误处理和 credentials */
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(error.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export const hindsightApi = {
  /** 获取 Hindsight 状态 + bankId */
  getStatus: () => apiFetch<{ success: boolean; data: HindsightStatus }>("/status"),

  /** 列出内存 */
  listMemories: (params?: { type?: string; q?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.type) qs.set("type", params.type);
    if (params?.q) qs.set("q", params.q);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    return apiFetch<MemoriesResponse>(`/memories?${qs.toString()}`);
  },

  /** 获取内存详情 */
  getMemory: (id: string) => apiFetch<MemoryDetail>(`/memories/${encodeURIComponent(id)}`),

  /** 删除内存 */
  deleteMemory: (id: string) =>
    apiFetch<{ success: boolean }>(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Recall 搜索 */
  recall: (params: { query: string; types?: string[]; max_tokens?: number }) =>
    apiFetch<RecallResponse>("/recall", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  /** Reflect 反思 */
  reflect: (params: { query: string; max_tokens?: number }) =>
    apiFetch<ReflectResponse>("/reflect", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  /** Retain 存储 */
  retain: (params: { items: Array<{ content: string; context?: string; tags?: string[] }> }) =>
    apiFetch<{ message?: string }>("/memories", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  /** 获取内存图谱数据（用于 Constellation/Graph/Timeline 视图） */
  getGraph: (params: {
    type: string;
    limit?: number;
    q?: string;
    tags?: string[];
    document_id?: string;
    chunk_id?: string;
  }) =>
    apiFetch<Record<string, any>>("/memories/graph", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  /** 获取 Bank 统计信息（整合状态等） */
  getBankStats: () => apiFetch<Record<string, any>>("/bank-stats"),

  /** 列出文档 */
  listDocuments: (params?: { q?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    return apiFetch<DocumentsResponse>(`/documents?${qs.toString()}`);
  },

  /** 上传文档（multipart/form-data，不设 Content-Type 让浏览器自动处理 boundary） */
  uploadDocument: (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return apiFetch<{ document_id: string }>("/documents", {
      method: "POST",
      // FormData 提交时不能手动设 Content-Type，浏览器会自动加 boundary
      headers: {} as Record<string, string>,
      body: formData,
    });
  },

  /** 删除文档 */
  deleteDocument: (id: string) =>
    apiFetch<{ success: boolean }>(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 列出心理模型 */
  listMentalModels: () => apiFetch<{ items: MentalModel[] }>("/mental-models"),

  /** 删除心理模型 */
  deleteMentalModel: (id: string) =>
    apiFetch<{ success: boolean }>(`/mental-models/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /** 列出实体 */
  listEntities: (params?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    return apiFetch<{ items: EntityItem[]; total: number }>(`/entities?${qs.toString()}`);
  },

  /** 获取单个实体详情 */
  getEntity: (id: string) => apiFetch<EntityItem>(`/entities/${encodeURIComponent(id)}`),

  /** 获取实体共现图谱 */
  getEntityGraph: (params?: { limit?: number; min_count?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.min_count !== undefined) qs.set("min_count", String(params.min_count));
    return apiFetch<EntityGraphResponse>(`/entities/graph?${qs.toString()}`);
  },
};
