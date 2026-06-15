import { config } from "../../config";
import type {
  KnowledgeBaseSnapshot,
  KnowledgeProvider,
  KnowledgeResourceContent,
  KnowledgeResourceSnapshot,
  KnowledgeSearchResult,
} from "./types";

/**
 * 将 RagFlow run.status 映射为统一的 KnowledgeResourceStatus
 * UNSTART/DEFAULT → pending, RUNNING → processing, SUCCESS → ready, FAIL/CANCEL → error
 */
function mapRunStatus(runStatus: string | undefined): "pending" | "processing" | "ready" | "error" {
  switch (runStatus) {
    case "UNSTART":
      return "pending";
    case "RUNNING":
      return "processing";
    case "SUCCESS":
      return "ready";
    case "FAIL":
    case "CANCEL":
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

/**
 * RagFlow 知识库 Provider
 * 通过 RagFlow REST API 管理知识库生命周期
 */
export class RagFlowKnowledgeProvider implements KnowledgeProvider {
  /**
   * 通用 API 请求封装
   * - 拼接 baseUrl + path
   * - 注入 Bearer token
   * - 检查 HTTP status 与业务 code
   * - 支持 AbortController 超时
   */
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = config.ragflowRequestTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `${config.ragflowApiUrl}${path}`;
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${config.ragflowApiKey}`);
      // 默认 JSON，文件上传时不设置以让 fetch 自动生成 multipart boundary
      if (!headers.has("Content-Type") && typeof init?.body === "string") {
        headers.set("Content-Type", "application/json");
      }

      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const payload = await response.json();

      if (!response.ok) {
        const message = (payload as RagFlowResponse).message ?? `HTTP ${response.status}`;
        throw new Error(message);
      }

      if ((payload as RagFlowResponse).code !== 0) {
        const { code, message } = payload as RagFlowResponse;
        throw new Error(`code=${code}: ${message}`);
      }

      return payload as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async createKnowledgeBase(input: {
    userId: string;
    slug: string;
    name: string;
    description?: string;
  }): Promise<KnowledgeBaseSnapshot> {
    const displayName = `[org_${input.userId}] ${input.name}`;

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
    await this.request(`/api/v1/datasets/${input.knowledgeBaseRemoteId}`, {
      method: "DELETE",
    });
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
          docs: Array<{ id: string; name?: string; run?: { status: string; message?: string } }>;
        }>
      >(`/api/v1/datasets/${datasetId}/documents?page=1&page_size=50`);

      const docs = statusPayload.data?.docs ?? [];
      const targetDoc = docs.find((d) => d.id === documentId);

      if (!targetDoc) {
        throw new Error("document not found during polling");
      }

      const runStatus = targetDoc.run?.status;

      if (runStatus === "SUCCESS") {
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

      if (runStatus === "FAIL" || runStatus === "CANCEL") {
        throw new Error(targetDoc.run?.message ?? `parse ${runStatus}`);
      }

      // RUNNING / UNSTART 继续轮询
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
            run?: { status: string; message?: string };
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
          status: mapRunStatus(doc.run?.status),
          source: doc.source_url ?? null,
          lastError: doc.run?.message ?? null,
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
    await this.request(`/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/${input.resourceRemoteId}`, {
      method: "DELETE",
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
}

/** Verify RagFlow connectivity. Called at RCS startup. */
export async function checkRagFlowHealth(): Promise<{ ok: boolean; message: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    // RagFlow v0.26.0 没有公开的 health/version 端点，只要 TCP 可达即视为健康
    const response = await fetch(`${config.ragflowApiUrl}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${config.ragflowApiKey}` },
    });
    clearTimeout(timeout);

    // 任何 HTTP 响应（包括 404）都说明服务可达
    return { ok: true, message: `RagFlow is reachable (status=${response.status})` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Cannot reach RagFlow: ${message}` };
  }
}
