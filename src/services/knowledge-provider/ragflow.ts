import { config } from "../../config";
import type {
  KnowledgeBaseSnapshot,
  KnowledgeProvider,
  KnowledgeResourceContent,
  KnowledgeResourceSnapshot,
  KnowledgeSearchResult,
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
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    this.ensureConfigured();
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
