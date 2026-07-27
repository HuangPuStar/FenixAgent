import { config } from "../../config";
import type {
  EmbeddingModelOption,
  InstanceModelOption,
  KnowledgeBaseSnapshot,
  KnowledgeChunk,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgePipelineOption,
  KnowledgeProvider,
  KnowledgeResourceContent,
  KnowledgeResourceSnapshot,
  KnowledgeSearchResult,
  ProviderInstanceOption,
  ProviderModelOption,
  RerankModelOption,
} from "./types";

/**
 * 将 RagFlow 文档 run 字段映射为统一的 KnowledgeResourceStatus。
 * RagFlow 文档列表接口直接返回 run 字符串，DONE 表示解析完成。
 */
function mapRunStatus(runStatus: string | undefined): "pending" | "processing" | "ready" | "error" {
  switch (runStatus) {
    case "UNSTART":
      return "pending";
    case "RUNNING":
      return "processing";
    case "DONE":
      return "ready";
    case "FAIL":
      return "error";
    default:
      return "pending";
  }
}

/** 轮询最大间隔（毫秒） */
const POLL_MAX_INTERVAL_MS = 30_000;

/** 初始轮询间隔（毫秒） */
const POLL_INITIAL_INTERVAL_MS = 1_000;

/**
 * RagFlow 业务响应通用结构
 */
interface RagFlowResponse<T = unknown> {
  code: number;
  message?: string;
  data?: T;
}

/** 判断 RagFlow 返回体是否是业务响应对象。 */
function isRagFlowResponse(value: unknown): value is RagFlowResponse {
  return typeof value === "object" && value !== null && "code" in value;
}

/**
 * RagFlow 知识库 Provider
 * 通过 RagFlow REST API 管理知识库生命周期
 */
export class RagFlowKnowledgeProvider implements KnowledgeProvider {
  /**
   * 知识库能力依赖 RagFlow API key；缺失时提前失败，
   * 避免把空 Bearer token 发送给上游后再收到难定位的 401。
   */
  private ensureConfigured() {
    if (!config.ragflowApiKey.trim()) {
      throw new Error("RAGFLOW_API_KEY is not configured");
    }
  }

  /**
   * 通用 API 请求封装
   * - 拼接 baseUrl + path
   * - 注入 Bearer token
   * - 检查 HTTP status 与业务 code
   * - 支持 AbortController 超时
   */
  private async request<T>(path: string, init?: RequestInit, apiKey?: string): Promise<T> {
    this.ensureConfigured();
    const controller = new AbortController();
    const timeoutMs = config.ragflowRequestTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `${config.ragflowApiUrl}${path}`;
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${apiKey ?? config.ragflowApiKey}`);
      // 默认 JSON，文件上传时不设置以让 fetch 自动生成 multipart boundary
      if (!headers.has("Content-Type") && typeof init?.body === "string") {
        headers.set("Content-Type", "application/json");
      }

      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      let payload: unknown = null;
      if (typeof response.text === "function") {
        const rawText = await response.text();
        if (rawText.trim().length > 0) {
          try {
            payload = JSON.parse(rawText);
          } catch (err) {
            console.error(err);
            throw new Error(`RagFlow returned non-JSON response: HTTP ${response.status}`);
          }
        }
      } else {
        // 兼容测试里的轻量 fetch stub；真实 Response 始终提供 text()。
        payload = await response.json();
      }

      if (!response.ok) {
        const responseMessage = isRagFlowResponse(payload) ? payload.message?.trim() : "";
        const message = responseMessage || `HTTP ${response.status}`;
        throw new Error(`RagFlow request failed (status=${response.status}): ${message}`);
      }

      // DELETE 类接口有些 RagFlow 部署返回 204/空响应，视作 HTTP 层成功。
      if (payload === null && response.status === 204) {
        return { code: 0 } as T;
      }

      if (!isRagFlowResponse(payload)) {
        throw new Error("RagFlow returned unexpected response");
      }

      if (payload.code !== 0) {
        const { code, message } = payload;
        throw new Error(`code=${code}: ${message}`);
      }

      return payload as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 从 RAGFlow 下载原始文件（二进制流），失败时返回 null */
  async downloadResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
  }): Promise<{ content: ReadableStream<Uint8Array>; contentType: string; fileName: string } | null> {
    this.ensureConfigured();
    const controller = new AbortController();
    const timeoutMs = config.ragflowRequestTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `${config.ragflowApiUrl}/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/${input.resourceRemoteId}`;
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.ragflowApiKey}` },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) return null;

      const disposition = response.headers.get("Content-Disposition") ?? "";
      const fileNameMatch = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      const fileName = fileNameMatch?.[1]?.replace(/['"]/g, "") ?? "document";
      const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";

      return { content: response.body, contentType, fileName };
    } finally {
      clearTimeout(timeout);
    }
  }

  async createKnowledgeBase(input: {
    organizationId: string;
    userId: string;
    slug: string;
    name: string;
    description?: string;
  }): Promise<KnowledgeBaseSnapshot> {
    const displayName = `[org_${input.organizationId}] ${input.name}`;

    const payload = await this.request<RagFlowResponse<{ id: string; name: string }>>("/api/v1/datasets", {
      method: "POST",
      body: JSON.stringify({
        name: displayName,
        description: input.description ?? "",
      }),
      headers: { "Content-Type": "application/json" },
    });

    return {
      remoteId: payload.data!.id,
      name: input.name,
      status: "empty",
    };
  }

  async deleteKnowledgeBase(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<void> {
    try {
      await this.request(`/api/v1/datasets/${input.knowledgeBaseRemoteId}`, {
        method: "DELETE",
      });
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("MethodNotAllowed") && !message.includes("405")) {
        throw err;
      }

      // RagFlow v0.26 的 dataset 删除接口使用集合端点 + ids body，
      // 保留上面的旧路径优先尝试以兼容已经部署过的旧版本。
      await this.request("/api/v1/datasets", {
        method: "DELETE",
        body: JSON.stringify({ ids: [input.knowledgeBaseRemoteId] }),
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  /** 列出远程数据集（RAGFlow 中所有数据集） */
  async listDatasets(_input: { apiKey?: string }): Promise<Array<{ id: string; name: string }>> {
    const payload = await this.request<RagFlowResponse<Array<{ id: string; name: string; description?: string }>>>(
      "/api/v1/datasets",
      { method: "GET" },
    );
    return (payload.data ?? []).map((ds) => ({ id: ds.id, name: ds.name }));
  }

  async addResource(input: {
    knowledgeBaseRemoteId?: string | null;
    targetRemoteId?: string | null;
    remoteAccountId: string;
    remoteUserId: string;
    filePath?: string;
    url?: string;
    sourceName?: string;
    wait?: boolean;
  }): Promise<KnowledgeResourceSnapshot> {
    const datasetId = input.knowledgeBaseRemoteId!;

    // 上传文件或 URL 到 knowledge base
    const formData = new FormData();
    if (input.filePath) {
      // ⚠️ Bun.file() returns BunFile, appending to FormData generates multipart/form-data.
      // Verify target RagFlow version's multipart parser accepts Bun-generated boundary and Content-Disposition headers.
      formData.append("file", Bun.file(input.filePath), input.sourceName ?? input.filePath);
    } else if (input.url) {
      formData.append("url", input.url);
    }
    if (input.sourceName) {
      formData.append("name", input.sourceName);
    }

    // Content-Type 不设置，让 fetch 自动生成带 boundary 的 multipart/form-data
    const uploadPayload = await this.request<
      RagFlowResponse<Array<{ id: string; name?: string; type?: string; source_url?: string }>>
    >(`/api/v1/datasets/${datasetId}/documents`, {
      method: "POST",
      body: formData,
      headers: {}, // 清空默认 Content-Type，让 fetch 自动处理 multipart
    });

    // 校验上传响应
    const uploadedDocs = uploadPayload.data;
    if (!Array.isArray(uploadedDocs) || uploadedDocs.length === 0) {
      throw new Error("upload returned unexpected response");
    }
    const documentId = uploadedDocs[0].id;

    // 触发解析
    await this.request(`/api/v1/datasets/${datasetId}/chunks`, {
      method: "POST",
      body: JSON.stringify({ document_ids: [documentId] }),
      headers: { "Content-Type": "application/json" },
    });

    // 仅在显式传入 wait=false 时跳过轮询，默认（undefined）为阻塞等待
    if (input.wait === false) {
      return {
        remoteId: documentId,
        knowledgeBaseRemoteId: datasetId,
        sourceName: input.sourceName ?? input.filePath ?? input.url ?? documentId,
        sourceType: input.filePath ? "file" : input.url ? "url" : "unknown",
        status: "processing",
        source: uploadedDocs[0].source_url ?? input.url ?? input.filePath ?? null,
        lastError: null,
      };
    }

    // blocking 模式：指数退避轮询直到解析完成
    let interval = POLL_INITIAL_INTERVAL_MS;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);

      const statusPayload = await this.request<
        RagFlowResponse<{
          docs: Array<{
            id: string;
            name?: string;
            run?: string;
            progress?: number;
            progress_msg?: string;
            chunk_count?: number;
            token_count?: number;
          }>;
        }>
      >(`/api/v1/datasets/${datasetId}/documents?page=1&page_size=50`);

      const docs = statusPayload.data?.docs ?? [];
      const targetDoc = docs.find((d) => d.id === documentId);

      if (!targetDoc) {
        throw new Error("document not found during polling");
      }

      const targetRunStatus = targetDoc.run;
      const targetRunMessage = targetDoc.progress_msg;

      // 解析状态异常时，进度与分块/Token 计数是定位 RagFlow 解析卡住的关键上下文。
      console.log("[ragflow] polling document parse status", {
        datasetId,
        documentId,
        run: targetRunStatus,
        progress: targetDoc.progress,
        progress_msg: targetRunMessage,
        chunk_count: targetDoc.chunk_count,
        token_count: targetDoc.token_count,
      });

      if (targetRunStatus === "DONE") {
        return {
          remoteId: documentId,
          knowledgeBaseRemoteId: datasetId,
          sourceName: input.sourceName ?? input.filePath ?? input.url ?? documentId,
          sourceType: input.filePath ? "file" : input.url ? "url" : "unknown",
          status: "ready",
          source: uploadedDocs[0].source_url ?? input.url ?? input.filePath ?? null,
          lastError: null,
        };
      }

      if (targetRunStatus === "FAIL") {
        console.error("[ragflow] document parse failed", {
          datasetId,
          documentId,
          run: targetRunStatus,
          progress: targetDoc.progress,
          progress_msg: targetRunMessage,
          chunk_count: targetDoc.chunk_count,
          token_count: targetDoc.token_count,
        });
        throw new Error(targetRunMessage ?? `parse ${targetRunStatus}`);
      }

      // RUNNING / UNSTART 继续轮询，未知状态也保守等待，避免 RagFlow 新状态导致误判失败。
    }
  }

  async listResources(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<KnowledgeResourceSnapshot[]> {
    const datasetId = input.knowledgeBaseRemoteId;
    const pageSize = 50;
    const allDocs: Array<KnowledgeResourceSnapshot> = [];
    let page = 1;

    // 分页循环拉取所有文档
    while (true) {
      const payload = await this.request<
        RagFlowResponse<{
          total?: number;
          docs: Array<{
            id: string;
            name?: string;
            type?: string;
            source_url?: string;
            run?: string;
            progress_msg?: string;
            chunk_count?: number;
            progress?: number;
            status?: string;
          }>;
        }>
      >(`/api/v1/datasets/${datasetId}/documents?page=${page}&page_size=${pageSize}`);

      const { total, docs } = payload.data ?? {};

      if (!Array.isArray(docs) || docs.length === 0) {
        break;
      }

      for (const doc of docs) {
        allDocs.push({
          remoteId: doc.id,
          knowledgeBaseRemoteId: datasetId,
          sourceName: doc.name ?? doc.id,
          sourceType: doc.type ?? "unknown",
          status: mapRunStatus(doc.run),
          source: doc.source_url ?? null,
          lastError: doc.progress_msg ?? null,
          chunkCount: doc.chunk_count ?? null,
          enabled: doc.status === "1" ? true : doc.status === "0" ? false : null,
          runStatus: doc.run ?? null,
          parseProgress: doc.progress != null ? doc.progress : null,
        });
      }

      // total 为 undefined 时也以空页为终止条件
      if (total !== undefined && allDocs.length >= total) {
        break;
      }

      page += 1;
    }

    return allDocs;
  }

  async deleteResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    recursive?: boolean;
  }): Promise<void> {
    try {
      await this.request(`/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/${input.resourceRemoteId}`, {
        method: "DELETE",
      });
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("MethodNotAllowed") && !message.includes("405")) {
        throw err;
      }

      // RagFlow v0.26 的 document 删除接口使用集合端点 + ids body。
      await this.request(`/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents`, {
        method: "DELETE",
        body: JSON.stringify({ ids: [input.resourceRemoteId] }),
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // 检索测试专用（返回丰富字段：chunk detail + doc aggs）
  async searchDetailed(input: {
    knowledgeBases: Array<{ remoteId: string; remoteAccountId: string; remoteUserId: string }>;
    query: string;
    topK: number;
    similarityThreshold?: number;
    vectorSimilarityWeight?: number;
    rerankId?: string | null;
    keyword?: boolean;
    highlight?: boolean;
    pageSize?: number;
    page?: number;
    useKg?: boolean;
    crossLanguages?: string[];
    metaDataFilter?: import("./types").MetaDataFilter;
  }): Promise<import("./types").KnowledgeRetrievalDetailedResult> {
    const datasetIds = input.knowledgeBases.map((kb) => kb.remoteId);
    const body: Record<string, unknown> = {
      question: input.query,
      dataset_ids: datasetIds,
      top_k: input.topK,
      highlight: input.highlight ?? true,
    };
    if (input.similarityThreshold != null) body.similarity_threshold = input.similarityThreshold;
    if (input.vectorSimilarityWeight != null) body.vector_similarity_weight = input.vectorSimilarityWeight;
    if (input.rerankId?.trim()) body.rerank_id = input.rerankId.trim();
    if (input.keyword != null) body.keyword = input.keyword;
    if (input.pageSize != null) body.size = input.pageSize;
    if (input.page != null) body.page = input.page;
    if (input.useKg != null) body.use_kg = input.useKg;
    if (input.crossLanguages?.length) body.cross_languages = input.crossLanguages;
    if (input.metaDataFilter?.method !== "disabled") body.meta_data_filter = input.metaDataFilter;

    const payload = await this.request<
      RagFlowResponse<{
        chunks?: Array<{
          chunk_id?: string;
          id?: string;
          content_with_weight?: string;
          content?: string;
          docnm_kwd?: string;
          document_name?: string;
          doc_id?: string;
          document_id?: string;
          kb_id?: string;
          dataset_id?: string;
          similarity?: number;
          vector_similarity?: number;
          term_similarity?: number;
          highlight?: string;
          important_kwd?: string[] | string;
          important_keywords?: string[] | string;
        }>;
        total?: number;
        doc_aggs?: Array<{ doc_name?: string; doc_id?: string; count?: number }>;
      }>
    >("/api/v1/datasets/search", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    const rawChunks = payload.data?.chunks ?? [];
    const chunks = rawChunks.map((chunk) => {
      const content = chunk.content_with_weight ?? chunk.content ?? "";
      const documentName = chunk.docnm_kwd ?? chunk.document_name ?? "";
      const documentId = chunk.doc_id ?? chunk.document_id ?? "";
      const datasetId = chunk.kb_id ?? chunk.dataset_id ?? "";
      let importantKeywords: string[] | undefined;
      if (Array.isArray(chunk.important_kwd))
        importantKeywords = chunk.important_kwd.filter((k): k is string => typeof k === "string");
      else if (typeof chunk.important_kwd === "string" && chunk.important_kwd.trim())
        importantKeywords = chunk.important_kwd
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
      else if (Array.isArray(chunk.important_keywords))
        importantKeywords = chunk.important_keywords.filter((k): k is string => typeof k === "string");
      return {
        chunkId: chunk.chunk_id ?? chunk.id ?? "",
        content,
        documentName,
        documentId,
        datasetId,
        similarity: chunk.similarity ?? 0,
        vectorSimilarity: chunk.vector_similarity,
        termSimilarity: chunk.term_similarity,
        highlight: chunk.highlight,
        importantKeywords,
      };
    });
    const total = payload.data?.total ?? chunks.length;
    const docAggs = (payload.data?.doc_aggs ?? []).map((agg) => ({
      documentName: agg.doc_name ?? "",
      documentId: agg.doc_id ?? "",
      count: agg.count ?? 0,
    }));
    return { chunks, total, docAggs };
  }

  // 资源启用/禁用开关
  async setResourceEnabled(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    enabled: boolean;
  }): Promise<void> {
    await this.request(`/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/batch-update-status`, {
      method: "POST",
      body: JSON.stringify({ doc_ids: [input.resourceRemoteId], status: input.enabled ? 1 : 0 }),
      headers: { "Content-Type": "application/json" },
    });
  }

  // 重新解析资源
  async reparseResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    deleteOld: boolean;
  }): Promise<void> {
    await this.request("/api/v1/documents/ingest", {
      method: "POST",
      body: JSON.stringify({
        doc_ids: [input.resourceRemoteId],
        run: 1,
        delete: input.deleteOld,
        apply_kb: false,
      }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async search(input: {
    knowledgeBases: Array<{
      remoteId: string;
      remoteAccountId: string;
      remoteUserId: string;
    }>;
    query: string;
    topK: number;
  }): Promise<KnowledgeSearchResult[]> {
    // 收集所有要检索的 dataset_id
    const datasetIds = input.knowledgeBases.map((kb) => kb.remoteId);

    const payload = await this.request<
      RagFlowResponse<{
        chunks?: Array<{
          content: string;
          document_name?: string;
          document_id?: string;
          dataset_id?: string;
          similarity?: number;
          chunk_id?: string;
        }>;
      }>
    >("/api/v1/retrieval", {
      method: "POST",
      body: JSON.stringify({
        question: input.query,
        dataset_ids: datasetIds,
        top_k: input.topK,
      }),
      headers: { "Content-Type": "application/json" },
    });

    const chunks = payload.data?.chunks ?? [];

    return chunks.map((chunk) => ({
      title: chunk.document_name ?? chunk.chunk_id ?? "result",
      snippet: chunk.content,
      source: chunk.document_name ?? chunk.document_id ?? chunk.chunk_id ?? "result",
      // 注意：source 字段放什么? chunk 没有独立 source_url，用 document_name 兜底
      score: chunk.similarity ?? 0,
      knowledgeBaseId: chunk.dataset_id ?? null,
      resourceId: chunk.document_id ?? null,
    }));
  }

  async readResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<KnowledgeResourceContent> {
    const payload = await this.request<
      RagFlowResponse<{
        doc?: { name?: string; type?: string; source_url?: string };
        chunks?: Array<{ content: string }>;
      }>
    >(`/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/${input.resourceRemoteId}/chunks`);

    const { doc, chunks } = payload.data ?? {};
    const content = (chunks ?? []).map((c) => c.content).join("\n\n");

    return {
      resourceId: input.resourceRemoteId,
      title: doc?.name ?? input.resourceRemoteId,
      content,
      source: doc?.source_url ?? null,
    };
  }

  /**
   * 分页拉取资源内的切片列表（含关键词）。
   * 调用 RAGFlow GET /api/v1/datasets/{id}/documents/{doc_id}/chunks
   */
  async listChunks(input: {
    knowledgeBaseRemoteId: string;
    resourceRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    page: number;
    pageSize: number;
    keyword?: string;
  }): Promise<{ items: KnowledgeChunk[]; total: number; page: number; pageSize: number }> {
    const params = new URLSearchParams();
    params.set("page", String(input.page));
    params.set("page_size", String(input.pageSize));
    if (input.keyword?.trim()) {
      params.set("keywords", input.keyword.trim());
    }

    const payload = await this.request<
      RagFlowResponse<{
        total?: number;
        chunks?: Array<{
          id: string;
          content: string;
          important_keywords?: string[];
          available_int?: number;
        }>;
      }>
    >(
      `/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/${input.resourceRemoteId}/chunks?${params.toString()}`,
    );

    const { chunks, total } = payload.data ?? {};
    const chunkList = chunks ?? [];

    const items: KnowledgeChunk[] = chunkList.map((c, idx) => ({
      id: c.id,
      content: c.content ?? "",
      chunkIndex: (input.page - 1) * input.pageSize + idx + 1,
      importantKeywords: Array.isArray(c.important_keywords) ? c.important_keywords : [],
      enabled: c.available_int !== 0,
    }));

    return {
      items,
      total: total ?? items.length,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  /**
   * 切换单个切片的启用/禁用状态。
   */
  async switchChunk(input: {
    knowledgeBaseRemoteId: string;
    resourceRemoteId: string;
    chunkId: string;
    available: boolean;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<void> {
    await this.request(
      `/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/${input.resourceRemoteId}/chunks/${input.chunkId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ available: input.available ? 1 : 0 }),
      },
    );
  }

  // ========== 模型列表 & Pipeline 拉取 ==========

  async listEmbeddingModels(_apiKey?: string): Promise<EmbeddingModelOption[]> {
    return this.listModelsByType("embedding");
  }

  async listRerankModels(_apiKey?: string): Promise<RerankModelOption[]> {
    return this.listModelsByType("rerank");
  }

  async listPipelines(_apiKey?: string): Promise<KnowledgePipelineOption[]> {
    try {
      const payload = await this.request<
        RagFlowResponse<{
          canvas: Array<{ id?: string; title?: string }>;
          total: number;
        }>
      >("/api/v1/agents?canvas_category=dataflow_canvas");
      const items = Array.isArray(payload.data?.canvas) ? payload.data.canvas : [];
      return items
        .map((item) => ({
          id: String(item.id ?? ""),
          name: String(item.title ?? ""),
        }))
        .filter((item) => item.id.length > 0);
    } catch {
      return [];
    }
  }

  async listFactories(_apiKey?: string): Promise<Array<{ name: string; tags?: string | null; url?: string | null }>> {
    try {
      const payload = await this.request<
        RagFlowResponse<Array<{ name?: string; tags?: string | null; url?: Record<string, string> | string | null }>>
      >("/api/v1/providers?available=true");
      const items = Array.isArray(payload.data) ? payload.data : [];
      return items
        .filter((item) => item && typeof item.name === "string" && item.name.trim().length > 0)
        .map((item) => {
          let url: string | null = null;
          if (typeof item.url === "string") url = item.url;
          else if (item.url && typeof item.url === "object" && item.url.default) url = item.url.default;
          return { name: String(item.name), tags: item.tags ?? null, url };
        });
    } catch {
      return [];
    }
  }

  // ============================================================
  // Embedding 模型管理方法
  // ============================================================

  /** 列出当前租户已配置的供应商名单（仅用户添加过的）。 */
  async listConfiguredProviders(apiKey?: string): Promise<string[]> {
    try {
      const payload = await this.request<RagFlowResponse<Array<{ name?: string }>>>(
        "/api/v1/providers",
        undefined,
        apiKey,
      );
      const items = Array.isArray(payload.data) ? payload.data : [];
      return items
        .filter((it) => it && typeof it.name === "string")
        .map((it) => String(it.name))
        .filter((n) => n.length > 0);
    } catch (err) {
      console.error("[ragflow] listConfiguredProviders failed:", err);
      return [];
    }
  }

  /** 列出某供应商下的实例 */
  async listProviderInstances(input: { apiKey?: string; provider: string }): Promise<ProviderInstanceOption[]> {
    try {
      const payload = await this.request<RagFlowResponse<Array<{ instance_name?: string; status?: string }>>>(
        `/api/v1/providers/${encodeURIComponent(input.provider)}/instances`,
        undefined,
        input.apiKey,
      );
      const items = Array.isArray(payload.data) ? payload.data : [];
      return items
        .filter((it) => it && typeof it.instance_name === "string")
        .map((it) => ({
          provider: input.provider,
          instanceName: String(it.instance_name),
          status: it.status != null ? String(it.status) : "active",
        }));
    } catch (err) {
      console.error("[ragflow] listProviderInstances failed:", err);
      return [];
    }
  }

  /** 列出某实例下的 embedding 模型（含 active/inactive 状态） */
  async listInstanceModels(input: {
    apiKey?: string;
    provider: string;
    instanceName: string;
  }): Promise<InstanceModelOption[]> {
    try {
      const payload = await this.request<
        RagFlowResponse<
          Array<{ name?: string; model_type?: string | string[]; max_tokens?: number | null; status?: string }>
        >
      >(
        `/api/v1/providers/${encodeURIComponent(input.provider)}/instances/${encodeURIComponent(input.instanceName)}/models`,
        undefined,
        input.apiKey,
      );
      const items = Array.isArray(payload.data) ? payload.data : [];
      return items
        .filter((it) => {
          if (!it || typeof it.name !== "string") return false;
          const types = it.model_type;
          const typeArr = Array.isArray(types) ? types : [types];
          return typeArr.some((t) => String(t ?? "").toLowerCase() === "embedding");
        })
        .map((it) => {
          const types = it.model_type;
          const modelType = Array.isArray(types) ? types.join(",") : String(types ?? "");
          return {
            name: String(it.name),
            provider: input.provider,
            instance: input.instanceName,
            modelType,
            maxTokens: it.max_tokens ?? null,
            status: it.status != null ? String(it.status) : "active",
          };
        });
    } catch (err) {
      console.error("[ragflow] listInstanceModels failed:", err);
      return [];
    }
  }

  /** 切换实例下单个模型的 active/inactive 状态 */
  async setModelStatus(input: {
    apiKey?: string;
    provider: string;
    instanceName: string;
    modelName: string;
    status: "active" | "inactive";
  }): Promise<void> {
    await this.request(
      `/api/v1/providers/${encodeURIComponent(input.provider)}/instances/${encodeURIComponent(input.instanceName)}/models/${encodeURIComponent(input.modelName)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: input.status }),
        headers: { "Content-Type": "application/json" },
      },
      input.apiKey,
    );
  }

  /** 验证厂商 API Key */
  async verifyProviderConnection(input: {
    apiKey?: string;
    provider: string;
    providerApiKey: string;
    baseUrl?: string | null;
  }): Promise<{ success: boolean; message?: string }> {
    const body: Record<string, unknown> = { api_key: input.providerApiKey };
    if (input.baseUrl?.trim()) body.base_url = input.baseUrl.trim();
    try {
      await this.request(
        `/api/v1/providers/${encodeURIComponent(input.provider)}/connection`,
        { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
        input.apiKey,
      );
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "验证失败";
      return { success: false, message };
    }
  }

  /** 动态列出某厂商的模型库（仅 embedding 类型） */
  async listProviderModels(input: {
    apiKey?: string;
    provider: string;
    providerApiKey: string;
    baseUrl?: string | null;
    modelType?: string;
  }): Promise<ProviderModelOption[]> {
    const params = new URLSearchParams({ api_key: input.providerApiKey });
    if (input.baseUrl?.trim()) params.set("base_url", input.baseUrl.trim());
    if (input.modelType) params.set("model_type", input.modelType);
    try {
      const payload = await this.request<
        RagFlowResponse<Array<{ name?: string; model_type?: string | string[]; max_tokens?: number | null }>>
      >(`/api/v1/providers/${encodeURIComponent(input.provider)}/models?${params.toString()}`, undefined, input.apiKey);
      const items = Array.isArray(payload.data) ? payload.data : [];
      return items
        .filter((item) => item && typeof item.name === "string")
        .map((item) => {
          const types = item.model_type;
          const modelType = Array.isArray(types) ? types.join(",") : String(types ?? "");
          return { name: String(item.name), modelType, maxTokens: item.max_tokens ?? null };
        });
    } catch (err) {
      console.error("[ragflow] listProviderModels failed:", err);
      return [];
    }
  }

  /** 添加厂商实例（幂等：已存在视为成功） */
  async addProviderInstance(input: {
    apiKey?: string;
    provider: string;
    instanceName: string;
    providerApiKey: string;
    baseUrl?: string | null;
  }): Promise<{ instanceName: string }> {
    const body: Record<string, unknown> = { instance_name: input.instanceName, api_key: input.providerApiKey };
    if (input.baseUrl?.trim()) body.base_url = input.baseUrl.trim();
    await this.request(
      `/api/v1/providers/${encodeURIComponent(input.provider)}/instances`,
      { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
      input.apiKey,
    );
    return { instanceName: input.instanceName };
  }

  /** 删除一个 provider 实例（含其下所有模型配置） */
  async deleteProviderInstance(input: { apiKey?: string; provider: string; instanceName: string }): Promise<void> {
    await this.request(
      `/api/v1/providers/${encodeURIComponent(input.provider)}/instances`,
      {
        method: "DELETE",
        body: JSON.stringify({ instances: [input.instanceName] }),
        headers: { "Content-Type": "application/json" },
      },
      input.apiKey,
    );
  }

  private async listModelsByType(type: "embedding" | "rerank"): Promise<EmbeddingModelOption[]> {
    let items: unknown[] = [];
    try {
      const payload = await this.request<RagFlowResponse<unknown[]>>("/api/v1/models");
      if (Array.isArray(payload.data)) items = payload.data;
    } catch {
      try {
        const payload =
          await this.request<RagFlowResponse<Array<{ llm_name?: string; name?: string; model_type?: string }>>>(
            "/api/v1/llm/list",
          );
        if (Array.isArray(payload.data)) items = payload.data;
      } catch {
        return [];
      }
    }
    return items
      .filter((item) => {
        if (typeof item !== "object" || item === null) return false;
        const record = item as Record<string, unknown>;
        const types = record.model_type;
        if (Array.isArray(types)) return types.some((t) => String(t).toLowerCase() === type);
        return String(types ?? "").toLowerCase() === type;
      })
      .map((item) => {
        const r = item as Record<string, unknown>;
        const modelName = String(r.name ?? "");
        const provider = String(r.provider_name ?? "");
        const instanceName = String(r.instance_name ?? "");
        if (instanceName && provider)
          return {
            name: `${modelName}@${instanceName}@${provider}`,
            label: `${instanceName} › ${modelName}`,
            provider,
            instance: instanceName,
          };
        if (provider)
          return { name: `${modelName}@${provider}`, label: `${provider} · ${modelName}`, provider, instance: "" };
        return { name: modelName, label: modelName, provider: "", instance: "" };
      })
      .filter((item) => item.name.length > 0);
  }

  // ============================================================
  // 知识图谱
  // ============================================================

  async generateKnowledgeGraph(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<void> {
    await this.request(`/api/v1/datasets/${input.knowledgeBaseRemoteId}/run_graphrag`, { method: "POST" });
  }

  async getKnowledgeGraph(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<{ graph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }; mind_map?: unknown } | null> {
    const payload = await this.request<
      RagFlowResponse<{
        graph?: { nodes?: KnowledgeGraphNode[]; edges?: KnowledgeGraphEdge[] };
        mind_map?: unknown;
      }>
    >(`/api/v1/datasets/${input.knowledgeBaseRemoteId}/knowledge_graph`, { method: "GET" });

    const data = payload.data;
    if (!data?.graph) return null;
    return {
      graph: { nodes: data.graph.nodes ?? [], edges: data.graph.edges ?? [] },
      mind_map: data.mind_map,
    };
  }

  async deleteKnowledgeGraph(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<void> {
    try {
      await this.request(`/api/v1/datasets/${input.knowledgeBaseRemoteId}/knowledge_graph`, { method: "DELETE" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("code=102")) return;
      throw err;
    }
  }

  async pollKnowledgeGraphProgress(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<{ progress: number; progressMsg?: string; taskId?: string }> {
    const payload = await this.request<RagFlowResponse<{ progress?: number; progress_msg?: string; task_id?: string }>>(
      `/api/v1/datasets/${input.knowledgeBaseRemoteId}/trace_graphrag`,
      { method: "GET" },
    );

    return {
      progress: payload.data?.progress ?? 0,
      progressMsg: payload.data?.progress_msg,
      taskId: payload.data?.task_id,
    };
  }
}

/** Verify RagFlow connectivity. Called at RCS startup. */
export async function checkRagFlowHealth(): Promise<{ ok: boolean; message: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    // 健康检查不应依赖业务 API key，避免把“服务可达”误判成“鉴权失败也算健康”。
    const response = await fetch(`${config.ragflowApiUrl}/api/v1/system/healthz`, {
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { ok: false, message: `RagFlow health check failed with status=${response.status}` };
    }

    return { ok: true, message: `RagFlow health check passed (status=${response.status})` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Cannot reach RagFlow: ${message}` };
  }
}
