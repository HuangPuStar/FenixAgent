import type {
  DocumentChunk,
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
      // FormData 提交时不能手动设 Content-Type，浏览器会自动加 multipart/form-data boundary
      ...(options?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(error.error ?? `HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: T } | T;
  return typeof json === "object" && json !== null && "data" in json ? (json.data as T) : (json as T);
}

export const hindsightApi = {
  /** 获取 Hindsight 状态 + bankId */
  getStatus: () => apiFetch<HindsightStatus>("/status"),

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
  deleteMemory: (id: string) => apiFetch<unknown>(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),

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
  }) => {
    const qs = new URLSearchParams();
    if (params.type) qs.set("type", params.type);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.q) qs.set("q", params.q);
    if (params.tags) qs.set("tags", params.tags.join(","));
    if (params.document_id) qs.set("document_id", params.document_id);
    if (params.chunk_id) qs.set("chunk_id", params.chunk_id);
    return apiFetch<Record<string, unknown>>(`/graph?${qs.toString()}`);
  },

  /** 获取 Bank 统计信息（整合状态等） */
  getBankStats: () => apiFetch<Record<string, unknown>>("/bank-stats"),

  /** 列出文档 */
  listDocuments: (params?: { q?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    return apiFetch<DocumentsResponse>(`/documents?${qs.toString()}`);
  },

  /** 上传文档（multipart/form-data，Content-Type 由 apiFetch 中 FormData 检测自动跳过） */
  uploadDocument: (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return apiFetch<{ document_id: string }>("/documents", {
      method: "POST",
      body: formData,
    });
  },

  /** 删除文档 */
  deleteDocument: (id: string) => apiFetch<unknown>(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 获取文档分块列表 */
  getDocumentChunks: (id: string) =>
    apiFetch<{ items: DocumentChunk[] }>(`/documents/${encodeURIComponent(id)}/chunks`),

  /** 列出心理模型 */
  listMentalModels: () => apiFetch<{ items: MentalModel[] }>("/mental-models"),

  /** 获取单个心理模型详情 */
  getMentalModel: (id: string) => apiFetch<MentalModel>(`/mental-models/${encodeURIComponent(id)}`),

  /** 删除心理模型 */
  deleteMentalModel: (id: string) =>
    apiFetch<unknown>(`/mental-models/${encodeURIComponent(id)}`, {
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
