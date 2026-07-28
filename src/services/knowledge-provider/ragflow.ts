import { config } from "../../config";
import type {
  ConfiguredModelInfo,
  EmbeddingModelOption,
  FactoryOption,
  InstanceModelOption,
  KnowledgeBaseSnapshot,
  KnowledgeChunk,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgePipelineOption,
  KnowledgeProvider,
  KnowledgeResourceContent,
  KnowledgeResourceSnapshot,
  KnowledgeRetrievalDetailedResult,
  KnowledgeSearchResult,
  MetaDataFilter,
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
  private ensureConfigured(apiKeyOverride?: string) {
    const apiKey = apiKeyOverride || config.ragflowApiKey;
    if (!apiKey.trim()) {
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
  private async request<T>(path: string, init?: RequestInit, apiKeyOverride?: string): Promise<T> {
    this.ensureConfigured(apiKeyOverride);
    const controller = new AbortController();
    const timeoutMs = config.ragflowRequestTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const apiKey = apiKeyOverride || config.ragflowApiKey;
      const url = `${config.ragflowApiUrl}${path}`;
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${apiKey}`);
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

  /** 下载原始文件（二进制），返回 Response 对象供调用方流式转发 */
  async downloadResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    apiKey?: string;
  }): Promise<{ content: ReadableStream<Uint8Array>; contentType: string; fileName: string } | null> {
    this.ensureConfigured(input.apiKey);
    const controller = new AbortController();
    const timeoutMs = config.ragflowRequestTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const apiKey = input.apiKey || config.ragflowApiKey;
      const url = `${config.ragflowApiUrl}/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/${input.resourceRemoteId}`;
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
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
    embeddingModel?: string | null;
    parseType?: number | null;
    pipelineId?: string | null;
    chunkMethod?: string | null;
    apiKey?: string;
  }): Promise<KnowledgeBaseSnapshot> {
    const displayName = `${input.name} [org_${input.organizationId}]`;

    // 仅在调用方显式指定时透传，否则让 RagFlow 使用租户默认配置
    const datasetBody: Record<string, unknown> = {
      name: displayName,
      description: input.description ?? "",
    };
    if (input.embeddingModel?.trim()) {
      const model = input.embeddingModel.trim();
      // RagFlow v0.26 要求 <model_name>@<provider> 格式，
      // 用户手动输入或旧数据可能不带 @provider，提前拦截给出明确提示
      if (!model.includes("@")) {
        throw new Error(
          `嵌入模型格式错误："${model}"，RagFlow v0.26 要求 <模型名>@<实例名>@<厂商名> 三段式格式，` +
            ` 例如 text-embedding-v3@qwen@Tongyi-Qianwen。请从下拉列表选择。`,
        );
      }
      datasetBody.embedding_model = model;
    }
    // RagFlow parse_type: 1=内置分块器 / 2=自定义 pipeline
    if (input.parseType != null) {
      datasetBody.parse_type = input.parseType;
    }
    // pipeline_id 仅 parseType=2 时生效
    if (input.pipelineId?.trim()) {
      datasetBody.pipeline_id = input.pipelineId.trim();
    }
    if (input.chunkMethod?.trim()) {
      datasetBody.chunk_method = input.chunkMethod.trim();
    }

    const payload = await this.request<RagFlowResponse<{ id: string; name: string }>>(
      "/api/v1/datasets",
      {
        method: "POST",
        body: JSON.stringify(datasetBody),
        headers: { "Content-Type": "application/json" },
      },
      input.apiKey,
    );

    return {
      remoteId: payload.data!.id,
      name: input.name,
      status: "empty",
      embeddingModel: input.embeddingModel?.trim() || null,
      chunkMethod: input.chunkMethod?.trim() || null,
    };
  }

  /** 列出 RAGFlow 租户下所有数据集（用于未关联 KB 导入） */
  async listDatasets(input: { apiKey?: string }): Promise<Array<{ id: string; name: string }>> {
    const payload = await this.request<RagFlowResponse<Array<{ id: string; name: string; description?: string }>>>(
      "/api/v1/datasets",
      { method: "GET" },
      input.apiKey,
    );
    return (payload.data ?? []).map((ds) => ({ id: ds.id, name: ds.name }));
  }

  /** 获取单个数据集详情（用于导入时同步嵌入模型、分块方法等配置） */
  async getDataset(input: { datasetId: string; apiKey?: string }): Promise<{
    embeddingModel?: string | null;
    chunkMethod?: string | null;
    parseMethod?: string | null;
    pipelineId?: string | null;
  } | null> {
    try {
      const payload = await this.request<
        RagFlowResponse<{
          embedding_model?: string;
          chunk_method?: string;
          parser_id?: string;
          parser_config?: { name?: string; pipeline_id?: string };
        }>
      >(`/api/v1/datasets/${input.datasetId}`, { method: "GET" }, input.apiKey);
      const ds = payload.data;
      if (!ds) return null;

      // RAGFlow 不同版本字段不同：优先 parser_id（v0.26），回退 chunk_method
      const parserId = ds.parser_id || ds.chunk_method;
      let parseMethod: string | null = null;
      if (parserId) {
        if (["naive", "book", "paper", "resume", "picture", "email", "qa"].includes(parserId)) {
          parseMethod = "builtin";
        } else {
          parseMethod = "pipeline";
        }
      }
      // 兼容 v0.26：chunk_method 直接就是分块方法名，parser_id 为空但 chunk_method 是内置方法名
      if (!parseMethod && ds.chunk_method) {
        const cm = ds.chunk_method;
        if (["naive", "book", "paper", "resume", "picture", "email", "qa"].includes(cm)) {
          parseMethod = "builtin";
        }
      }

      return {
        embeddingModel: ds.embedding_model?.trim() || null,
        chunkMethod: parserId || ds.chunk_method || null,
        parseMethod,
      };
    } catch (err) {
      console.error("[ragflow] getDataset failed:", err);
      return null;
    }
  }

  /**
   * 拉取 RagFlow 租户下已配置的嵌入模型列表。
   * v0.26+ 使用 GET /api/v1/models（Go API）；旧版使用 /api/v1/llm/list 作降级。
   * 上游不可用或返回异常时返回空数组，避免阻断创建表单。
   */
  async listEmbeddingModels(apiKey?: string): Promise<EmbeddingModelOption[]> {
    return this.listModelsByType("embedding", apiKey);
  }

  /**
   * 拉取 RagFlow 租户下已配置的 rerank 重排序模型列表，供检索测试选择。
   * 上游不可用时返回空数组。
   */
  async listRerankModels(apiKey?: string): Promise<RerankModelOption[]> {
    return this.listModelsByType("rerank", apiKey);
  }

  /**
   * 列出 RAGFlow 可用厂商（系统目录，available=true）。
   * 用于添加 embedding 模型时的厂商下拉。
   * GET /api/v1/providers?available=true
   */
  async listFactories(apiKey?: string): Promise<FactoryOption[]> {
    try {
      const payload = await this.request<
        RagFlowResponse<Array<{ name?: string; tags?: string | null; url?: Record<string, string> | string | null }>>
      >("/api/v1/providers?available=true", undefined, apiKey);
      const items = Array.isArray(payload.data) ? payload.data : [];
      return items
        .filter((item) => item && typeof item.name === "string" && item.name.trim().length > 0)
        .map((item) => {
          // url 可能是 {default: "..."} 对象，也可能是字符串
          let url: string | null = null;
          if (typeof item.url === "string") url = item.url;
          else if (item.url && typeof item.url === "object" && item.url.default) url = item.url.default;
          return { name: String(item.name), tags: item.tags ?? null, url };
        });
    } catch (err) {
      console.error("[ragflow] listFactories failed:", err);
      return [];
    }
  }

  /**
   * 验证厂商 API Key 是否可用。
   * POST /api/v1/providers/<provider_name>/connection  body { api_key, base_url? }
   */
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

  /**
   * 动态列出某厂商（用 api_key 临时访问）的模型库。
   * GET /api/v1/providers/<provider_name>/models?api_key=...&base_url=...
   */
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

  /**
   * 添加厂商实例（写入租户配置）。
   * POST /api/v1/providers/<provider_name>/instances  body { instance_name, api_key, base_url? }
   */
  async addProviderInstance(input: {
    apiKey?: string;
    provider: string;
    instanceName: string;
    providerApiKey: string;
    baseUrl?: string | null;
  }): Promise<{ instanceName: string }> {
    const body: Record<string, unknown> = {
      instance_name: input.instanceName,
      api_key: input.providerApiKey,
    };
    if (input.baseUrl?.trim()) body.base_url = input.baseUrl.trim();
    await this.request(
      `/api/v1/providers/${encodeURIComponent(input.provider)}/instances`,
      { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
      input.apiKey,
    );
    return { instanceName: input.instanceName };
  }

  /**
   * 列出当前租户已配置的供应商名单（不含系统目录，仅用户添加过的）。
   * GET /api/v1/providers（不带 available=true）
   *
   * 与 listFactories(available=true) 区别：后者是系统厂商目录全集；
   * 此处要的是租户自己添加过实例的 provider。
   */
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

  /**
   * 列出某供应商下当前租户已配置的实例。
   * GET /api/v1/providers/<provider_name>/instances
   * 返回 instance_name / status 等（不含 api_key）。
   */
  async listProviderInstances(input: { apiKey?: string; provider: string }): Promise<ProviderInstanceOption[]> {
    try {
      const payload = await this.request<
        RagFlowResponse<Array<{ instance_name?: string; status?: string; region?: string }>>
      >(`/api/v1/providers/${encodeURIComponent(input.provider)}/instances`, undefined, input.apiKey);
      const items = Array.isArray(payload.data) ? payload.data : [];
      return items
        .filter((it) => it && typeof it.instance_name === "string")
        .map((it) => ({
          provider: input.provider,
          instanceName: String(it.instance_name),
          status: it.status != null ? String(it.status) : "active",
          region: it.region ?? null,
        }));
    } catch (err) {
      console.error("[ragflow] listProviderInstances failed:", err);
      return [];
    }
  }

  /**
   * 列出某实例下的全部模型（含 active/inactive 状态）。
   * GET /api/v1/providers/<provider_name>/instances/<instance_name>/models
   *
   * 注意：与 /api/v1/models 的关键区别——此端点**不会过滤 inactive 模型**，
   * 且返回每个模型的 status（无 tenant_model 行时默认 active）。这是「模型管理
   * 列表」的正确数据源；/api/v1/models 会隐藏 inactive，无法用于管理 active/inactive。
   */
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
          // 只保留 embedding 类型：本页是「嵌入模型管理」，不展示 chat/rerank 等
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

  /**
   * 切换实例下单个模型的 active/inactive 状态。
   * PATCH /api/v1/providers/<provider>/instances/<instance>/models/<model_name>
   * body { status: "active" | "inactive" }（字符串，非 0/1）
   *
   * - 设为 inactive：RAGFlow 自动给 tenant_model 表落行；新建 KB 时该 embedding
   *   模型被拒绝（LookupError: Model ... is disabled），实现「新建时不可见」。
   * - 设为 active：恢复可用。
   * - 老知识库不受影响（仍用创建时绑定的模型）。
   */
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

  /**
   * 删除一个 provider 实例（含其下所有模型配置）。
   * DELETE /api/v1/providers/<provider_name>/instances
   * body { instances: ["instance_name"] }
   *
   * 删的是 tenant_model_instance 行 + 关联 tenant_model 行，**不删 provider 本身**。
   * 真正的删除粒度是「实例」（用户配置的一组 API Key），不是单个模型、也不是整个供应商。
   */
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

  /**
   * 列出已配置的 embedding 模型，附带 status 字段（供模型管理列表）。
   * 复用 listModelsByType，但映射时保留原始 status 字段。
   */
  async listConfiguredEmbeddingModels(apiKey?: string): Promise<ConfiguredModelInfo[]> {
    let items: unknown[] = [];
    try {
      const payload = await this.request<RagFlowResponse<unknown[]>>("/api/v1/models", undefined, apiKey);
      if (Array.isArray(payload.data)) items = payload.data;
    } catch {
      try {
        const payload = await this.request<
          RagFlowResponse<Array<{ llm_name?: string; name?: string; model_type?: string; status?: string }>>
        >("/api/v1/llm/list", undefined, apiKey);
        if (Array.isArray(payload.data)) items = payload.data;
      } catch (err) {
        console.error("[ragflow] listConfiguredEmbeddingModels failed:", err);
        return [];
      }
    }
    return items
      .filter((item) => {
        if (typeof item !== "object" || item === null) return false;
        const types = (item as Record<string, unknown>).model_type;
        if (Array.isArray(types)) return types.some((t) => String(t).toLowerCase() === "embedding");
        return String(types ?? "").toLowerCase() === "embedding";
      })
      .map((item) => {
        const r = item as Record<string, unknown>;
        const modelName = String(r.name ?? "");
        const provider = String(r.provider_name ?? "");
        const instanceName = String(r.instance_name ?? "");
        const llmName = String(r.llm_name ?? "");
        const legacyProvider = String(r.name ?? "");
        if (llmName && legacyProvider && !provider) {
          return {
            name: `${llmName}@${legacyProvider}`,
            label: `${legacyProvider} · ${llmName}`,
            provider: legacyProvider,
            instance: "",
            modelType: "embedding",
            status: r.status != null ? String(r.status) : null,
          };
        }
        const fullId =
          instanceName && provider
            ? `${modelName}@${instanceName}@${provider}`
            : provider
              ? `${modelName}@${provider}`
              : modelName;
        const label = provider ? `${instanceName} › ${modelName}` : modelName;
        return {
          name: fullId,
          label,
          provider,
          instance: instanceName,
          modelType: "embedding",
          status: r.status != null ? String(r.status) : null,
        };
      })
      .filter((item) => item.name.length > 0);
  }

  /**
   * 按模型类型拉取 RagFlow 模型列表（embedding / rerank 共用）。
   * v0.26+ 使用 GET /api/v1/models（model_type 为 string[]）；旧版使用 /api/v1/llm/list（model_type 为 string）。
   * 上游不可用或返回异常时返回空数组，避免阻断表单渲染。
   */
  private async listModelsByType(type: "embedding" | "rerank", apiKey?: string): Promise<RerankModelOption[]> {
    let items: unknown[] = [];

    // v0.26 标准端点
    try {
      const payload = await this.request<RagFlowResponse<unknown[]>>("/api/v1/models", undefined, apiKey);
      if (Array.isArray(payload.data)) {
        console.log(`[ragflow] listModelsByType(${type}) v0.26: got`, payload.data.length, "models");
        items = payload.data;
      }
    } catch (_err) {
      // 尝试旧版端点
      try {
        const payload = await this.request<
          RagFlowResponse<Array<{ llm_name?: string; name?: string; model_type?: string; fid?: string }>>
        >("/api/v1/llm/list", undefined, apiKey);
        if (Array.isArray(payload.data)) {
          console.log(`[ragflow] listModelsByType(${type}) legacy: got`, payload.data.length, "models");
          items = payload.data;
        }
      } catch (err) {
        console.error(`[ragflow] listModelsByType(${type}) both endpoints failed`, err);
        return [];
      }
    }

    return items
      .filter((item) => {
        if (typeof item !== "object" || item === null) return false;
        const record = item as Record<string, unknown>;
        // v0.26: model_type 是 string[]，精确匹配目标类型
        // 枚举值来自 RagFlow Go API: chat / embedding / image2text / rerank / speech2text / tts
        const types = record.model_type;
        if (Array.isArray(types)) {
          return types.some((t) => String(t).toLowerCase() === type);
        }
        // 旧版兼容: model_type 是 string
        return String(types ?? "").toLowerCase() === type;
      })
      .map((item) => {
        const r = item as Record<string, unknown>;
        const modelName = String(r.name ?? "");
        const provider = String(r.provider_name ?? "");
        const instanceName = String(r.instance_name ?? "");
        // 旧版兼容: llm_name(模型) + name(厂商)
        const llmName = String(r.llm_name ?? "");
        const legacyProvider = String(r.name ?? "");

        if (llmName && legacyProvider && !provider) {
          // 旧版格式: 两段式
          return {
            name: `${llmName}@${legacyProvider}`,
            label: `${legacyProvider} · ${llmName}`,
            provider: legacyProvider,
            instance: "",
          };
        }
        // v0.26 格式: 三段式 name@instance_name@provider_name
        const fullId =
          instanceName && provider
            ? `${modelName}@${instanceName}@${provider}`
            : provider
              ? `${modelName}@${provider}`
              : modelName;
        const label = provider ? `${instanceName} › ${modelName}` : modelName;
        return { name: fullId, label, provider, instance: instanceName };
      })
      .filter((item) => item.name.length > 0);
  }

  /**
   * 拉取 RagFlow 可用的解析 pipeline 列表（best-effort）。
   * pipeline 在 RagFlow 中对应"dataflow canvas"（canvas_category=dataflow_canvas），
   * 通过 GET /api/v1/agents 接口按类别筛选获取。
   * 旧端点 /api/v1/pipelines 和 /api/v1/agents/templates 均不是正确的数据来源。
   * 任何失败都视为无可用 pipeline。
   */
  async listPipelines(apiKey?: string): Promise<KnowledgePipelineOption[]> {
    try {
      const payload = await this.request<
        RagFlowResponse<{
          canvas: Array<{ id?: string; title?: string; description?: string | Record<string, string> }>;
          total: number;
        }>
      >("/api/v1/agents?canvas_category=dataflow_canvas", undefined, apiKey);

      const items = Array.isArray(payload.data?.canvas) ? payload.data.canvas : [];
      return items
        .map((item) => {
          // IFlow.title 是 string，但为防御性编程仍处理多语言对象的情况
          const title = item.title;
          const label =
            typeof title === "object" && title !== null
              ? String((title as Record<string, string>).en ?? (title as Record<string, string>).zh ?? "")
              : String(title ?? "");
          return {
            id: String(item.id ?? ""),
            name: label,
          };
        })
        .filter((item) => item.id.length > 0);
    } catch (_err) {
      console.error("[ragflow] listPipelines failed:", _err);
      return [];
    }
  }

  async deleteKnowledgeBase(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<void> {
    try {
      await this.request(
        `/api/v1/datasets/${input.knowledgeBaseRemoteId}`,
        {
          method: "DELETE",
        },
        input.apiKey,
      );
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("MethodNotAllowed") && !message.includes("405")) {
        throw err;
      }

      // RagFlow v0.26 的 dataset 删除接口使用集合端点 + ids body，
      // 保留上面的旧路径优先尝试以兼容已经部署过的旧版本。
      await this.request(
        "/api/v1/datasets",
        {
          method: "DELETE",
          body: JSON.stringify({ ids: [input.knowledgeBaseRemoteId] }),
          headers: { "Content-Type": "application/json" },
        },
        input.apiKey,
      );
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
    apiKey?: string;
  }): Promise<KnowledgeResourceSnapshot> {
    const datasetId = input.knowledgeBaseRemoteId!;

    // 步骤 1：上传文件或 URL 到 RAGFlow（仅上传，不触发解析）
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
    >(
      `/api/v1/datasets/${datasetId}/documents`,
      {
        method: "POST",
        body: formData,
        headers: {}, // 清空默认 Content-Type，让 fetch 自动处理 multipart
      },
      input.apiKey,
    );

    // 校验上传响应
    const uploadedDocs = uploadPayload.data;
    if (!Array.isArray(uploadedDocs) || uploadedDocs.length === 0) {
      throw new Error("upload returned unexpected response");
    }
    const documentId = uploadedDocs[0].id;
    const sourceUrl = uploadedDocs[0].source_url ?? input.url ?? input.filePath ?? null;

    // 步骤 2：异步触发重新解析（delete_old=true 清除旧分块后重新解析，新文件本来就没有旧分块）
    // 使用 RAGFlow ingest API：run=1 启动解析，delete=true 清除新文件已有的空分块，apply_kb=false 不自动应用
    await this.request(
      "/api/v1/documents/ingest",
      {
        method: "POST",
        body: JSON.stringify({
          doc_ids: [documentId],
          run: 1,
          delete: true,
          apply_kb: false,
        }),
        headers: { "Content-Type": "application/json" },
      },
      input.apiKey,
    );

    console.log("[ragflow] document upload + reparse triggered", { datasetId, documentId });

    // 立即返回，不等待解析完成（RAGFlow 后台异步解析）
    return {
      remoteId: documentId,
      knowledgeBaseRemoteId: datasetId,
      sourceName: input.sourceName ?? input.filePath ?? input.url ?? documentId,
      sourceType: input.filePath ? "file" : input.url ? "url" : "unknown",
      status: "processing",
      source: sourceUrl,
      lastError: null,
    };
  }

  async listResources(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
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
            progress?: number;
            chunk_count?: number;
            status?: string;
            meta_fields?: Record<string, unknown>;
            chunk_method?: string;
            size?: number;
          }>;
        }>
      >(`/api/v1/datasets/${datasetId}/documents?page=${page}&page_size=${pageSize}`, undefined, input.apiKey);

      const { total, docs } = payload.data ?? {};

      if (!Array.isArray(docs) || docs.length === 0) {
        break;
      }

      for (const doc of docs) {
        // RAGFlow 文件上传未显式指定 name 时会以 "内部ID, 原始文件名" 格式存储，
        // 使用正则剥离逗号前的数字前缀
        const rawName = doc.name ?? doc.id;
        const cleanName = rawName.replace(/^\d+,\s*/, "");
        allDocs.push({
          remoteId: doc.id,
          knowledgeBaseRemoteId: datasetId,
          sourceName: cleanName,
          sourceType: doc.type ?? "unknown",
          status: mapRunStatus(doc.run),
          source: doc.source_url ?? null,
          lastError: doc.progress_msg ?? null,
          enabled: doc.status === "1" ? true : doc.status === "0" ? false : true,
          chunkCount: doc.chunk_count ?? null,
          metaFields: doc.meta_fields ?? null,
          parseProgress: doc.progress ?? null,
          runStatus: doc.run ?? null,
          chunkMethod: doc.chunk_method ?? null,
          fileSize: doc.size ?? null,
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
    apiKey?: string;
  }): Promise<void> {
    try {
      await this.request(
        `/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/${input.resourceRemoteId}`,
        {
          method: "DELETE",
        },
        input.apiKey,
      );
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("MethodNotAllowed") && !message.includes("405")) {
        throw err;
      }

      // RagFlow v0.26 的 document 删除接口使用集合端点 + ids body。
      await this.request(
        `/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents`,
        {
          method: "DELETE",
          body: JSON.stringify({ ids: [input.resourceRemoteId] }),
          headers: { "Content-Type": "application/json" },
        },
        input.apiKey,
      );
    }
  }

  async setResourceEnabled(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    enabled: boolean;
    apiKey?: string;
  }): Promise<void> {
    await this.request(
      `/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/batch-update-status`,
      {
        method: "POST",
        body: JSON.stringify({
          doc_ids: [input.resourceRemoteId],
          status: input.enabled ? 1 : 0,
        }),
        headers: { "Content-Type": "application/json" },
      },
      input.apiKey,
    );
  }

  async reparseResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    deleteOld: boolean;
    apiKey?: string;
  }): Promise<void> {
    // RAGFlow ingest API 触发重新解析：run=1 启动，delete 清旧数据
    await this.request(
      "/api/v1/documents/ingest",
      {
        method: "POST",
        body: JSON.stringify({
          doc_ids: [input.resourceRemoteId],
          run: 1,
          delete: input.deleteOld,
          apply_kb: false,
        }),
        headers: { "Content-Type": "application/json" },
      },
      input.apiKey,
    );
  }

  async search(input: {
    knowledgeBases: Array<{
      remoteId: string;
      remoteAccountId: string;
      remoteUserId: string;
    }>;
    query: string;
    topK: number;
    /** 相似度阈值；缺省时由 RagFlow 用默认值 */
    similarityThreshold?: number;
    /** 向量相似度权重；缺省时由 RagFlow 用默认值 */
    vectorSimilarityWeight?: number;
    /** rerank 模型 ID；不传则不做 rerank */
    rerankId?: string | null;
    /** 是否启用关键词增强 */
    keyword?: boolean;
    /** 是否返回高亮 */
    highlight?: boolean;
    /** 每页返回数 */
    pageSize?: number;
    /** 页码 */
    page?: number;
    /** 是否启用知识图谱 */
    useKg?: boolean;
    /** 跨语言检索目标语言 */
    crossLanguages?: string[];
    /** 元数据过滤配置（支持 4 种模式：disabled/auto/semi_auto/manual） */
    metaDataFilter?: MetaDataFilter;
    apiKey?: string;
  }): Promise<KnowledgeSearchResult[]> {
    // 收集所有要检索的 dataset_id
    const datasetIds = input.knowledgeBases.map((kb) => kb.remoteId);

    // 构建请求体：基础字段始终透传，可选字段仅在调用方提供时透传，让 RagFlow 用其默认值
    const body: Record<string, unknown> = {
      question: input.query,
      dataset_ids: datasetIds,
      top_k: input.topK,
    };
    if (input.similarityThreshold != null) body.similarity_threshold = input.similarityThreshold;
    if (input.vectorSimilarityWeight != null) body.vector_similarity_weight = input.vectorSimilarityWeight;
    if (input.rerankId?.trim()) body.rerank_id = input.rerankId.trim();
    if (input.keyword != null) body.keyword = input.keyword;
    if (input.highlight != null) body.highlight = input.highlight;
    if (input.pageSize != null) body.page_size = input.pageSize;
    if (input.page != null) body.page = input.page;
    if (input.useKg != null) body.use_kg = input.useKg;
    if (input.crossLanguages != null && input.crossLanguages.length > 0) body.cross_languages = input.crossLanguages;
    if (input.metaDataFilter != null && input.metaDataFilter.method !== "disabled")
      body.meta_data_filter = input.metaDataFilter;

    const payload = await this.request<
      RagFlowResponse<{
        chunks?: Array<{
          content: string;
          document_keyword?: string;
          document_name?: string;
          document_id?: string;
          dataset_id?: string;
          similarity?: number;
          id?: string;
          chunk_id?: string;
        }>;
      }>
    >(
      "/api/v1/retrieval",
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
      input.apiKey,
    );

    const chunks = payload.data?.chunks ?? [];

    return chunks.map((chunk) => ({
      title: chunk.document_keyword ?? chunk.document_name ?? chunk.id ?? chunk.chunk_id ?? "result",
      snippet: chunk.content,
      source:
        chunk.document_keyword ?? chunk.document_name ?? chunk.document_id ?? chunk.id ?? chunk.chunk_id ?? "result",
      score: chunk.similarity ?? 0,
      knowledgeBaseId: chunk.dataset_id ?? null,
      resourceId: chunk.document_id ?? null,
    }));
  }

  /**
   * 检索测试专用：调用 /api/v1/datasets/search（与 RAGFlow 测试表单同一端点），
   * 原生支持 meta_data_filter 的 4 种模式（disabled/auto/semi_auto/manual）。
   * 与 search() 的区别：返回 KnowledgeRetrievalDetailedResult（含 total/docAggs），专供检索测试 UI。
   */
  async searchDetailed(input: {
    knowledgeBases: Array<{
      remoteId: string;
      remoteAccountId: string;
      remoteUserId: string;
    }>;
    query: string;
    topK: number;
    similarityThreshold?: number;
    vectorSimilarityWeight?: number;
    rerankId?: string | null;
    keyword?: boolean;
    highlight?: boolean;
    pageSize?: number;
    page?: number;
    /** 是否启用知识图谱 */
    useKg?: boolean;
    /** 跨语言检索目标语言 */
    crossLanguages?: string[];
    /** 元数据过滤配置（支持 4 种模式：disabled/auto/semi_auto/manual） */
    metaDataFilter?: MetaDataFilter;
    apiKey?: string;
  }): Promise<KnowledgeRetrievalDetailedResult> {
    const datasetIds = input.knowledgeBases.map((kb) => kb.remoteId);

    // 构建请求体：检索测试默认开启高亮，便于结果展示
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
    if (input.crossLanguages != null && input.crossLanguages.length > 0) body.cross_languages = input.crossLanguages;
    if (input.metaDataFilter != null && input.metaDataFilter.method !== "disabled")
      body.meta_data_filter = input.metaDataFilter;

    const payload = await this.request<
      RagFlowResponse<{
        chunks?: Array<{
          chunk_id?: string;
          id?: string;
          content_with_weight?: string;
          content?: string;
          document_keyword?: string;
          document_name?: string;
          docnm_kwd?: string;
          document_id?: string;
          doc_id?: string;
          dataset_id?: string;
          kb_id?: string;
          similarity?: number;
          vector_similarity?: number;
          term_similarity?: number;
          highlight?: string;
          important_keywords?: string[] | string;
          important_kwd?: string[] | string;
        }>;
        total?: number;
        count?: number;
        doc_aggs?: Array<{ doc_name?: string; doc_id?: string; count?: number }>;
      }>
    >(
      "/api/v1/datasets/search",
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
      input.apiKey,
    );

    const rawChunks = payload.data?.chunks ?? [];
    const chunks = rawChunks.map((chunk) => {
      // RAGFlow /api/v1/datasets/search 返回原始字段名（无 key mapping）：
      // - chunk_id、content_with_weight、doc_id、important_kwd、docnm_kwd、kb_id
      const content = chunk.content_with_weight ?? chunk.content ?? "";
      const documentName = chunk.docnm_kwd ?? chunk.document_name ?? chunk.document_keyword ?? "";
      const documentId = chunk.doc_id ?? chunk.document_id ?? "";
      const datasetId = chunk.kb_id ?? chunk.dataset_id ?? "";
      // important_kwd 可能是数组或逗号分隔字符串
      let importantKeywords: string[] | undefined;
      if (Array.isArray(chunk.important_kwd)) {
        importantKeywords = chunk.important_kwd.filter((k): k is string => typeof k === "string");
      } else if (typeof chunk.important_kwd === "string" && chunk.important_kwd.trim()) {
        importantKeywords = chunk.important_kwd
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
      } else if (Array.isArray(chunk.important_keywords)) {
        importantKeywords = chunk.important_keywords.filter((k): k is string => typeof k === "string");
      }

      return {
        chunkId: chunk.chunk_id ?? chunk.id ?? "",
        content,
        documentName,
        documentId,
        datasetId,
        similarity: chunk.similarity ?? 0,
        vectorSimilarity: chunk.vector_similarity,
        termSimilarity: chunk.term_similarity,
        // RAGFlow /api/v1/datasets/search 不返回 highlight，保留兼容
        highlight: chunk.highlight,
        importantKeywords,
      };
    });

    // total 字段：RagFlow 返回 total 或 count，兜底用 chunks 长度
    const total = payload.data?.total ?? payload.data?.count ?? chunks.length;
    // 文档聚合：doc_aggs 字段名映射
    const docAggs = (payload.data?.doc_aggs ?? []).map((agg) => ({
      documentName: agg.doc_name ?? "",
      documentId: agg.doc_id ?? "",
      count: agg.count ?? 0,
    }));

    return { chunks, total, docAggs };
  }

  async readResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<KnowledgeResourceContent> {
    // 先获取文档基本信息（类型、名称等），再获取分块内容
    const docPayload = await this.request<
      RagFlowResponse<{
        doc?: { name?: string; type?: string; source_url?: string };
        chunks?: Array<{ content: string }>;
      }>
    >(
      `/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/${input.resourceRemoteId}/chunks`,
      undefined,
      input.apiKey,
    );

    const { doc, chunks } = docPayload.data ?? {};
    const chunkList = chunks ?? [];
    const content = chunkList.map((c) => c.content).join("\n\n");

    return {
      resourceId: input.resourceRemoteId,
      title: doc?.name ?? input.resourceRemoteId,
      content,
      source: doc?.source_url ?? null,
      docType: doc?.type ?? null,
      chunkCount: chunkList.length,
    };
  }

  /**
   * 分页拉取资源内的切片列表（含关键词）。
   * 调用 RAGFlow GET /api/v1/datasets/{id}/documents/{doc_id}/chunks，支持分页和关键词搜索。
   */
  async listChunks(input: {
    knowledgeBaseRemoteId: string;
    resourceRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    page: number;
    pageSize: number;
    keyword?: string;
    apiKey?: string;
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
      undefined,
      input.apiKey,
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
   * 调用 RAGFlow PATCH /api/v1/datasets/{id}/documents/{doc_id}/chunks/{chunk_id}，
   * body: { available: 0|1 }。
   */
  async switchChunk(input: {
    knowledgeBaseRemoteId: string;
    resourceRemoteId: string;
    chunkId: string;
    available: boolean;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<void> {
    await this.request(
      `/api/v1/datasets/${input.knowledgeBaseRemoteId}/documents/${input.resourceRemoteId}/chunks/${input.chunkId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ available: input.available ? 1 : 0 }),
      },
      input.apiKey,
    );
  }

  // ============================================================
  // 知识图谱
  // ============================================================

  async generateKnowledgeGraph(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<void> {
    const datasetId = input.knowledgeBaseRemoteId;
    // v0.26.0 正确端点：POST /api/v1/datasets/{id}/run_graphrag（无 body）
    await this.request(
      `/api/v1/datasets/${datasetId}/run_graphrag`,
      {
        method: "POST",
      },
      input.apiKey,
    );
  }

  async getKnowledgeGraph(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<{ graph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }; mind_map?: unknown } | null> {
    const datasetId = input.knowledgeBaseRemoteId;
    // v0.26.0 正确端点：GET /api/v1/datasets/{id}/knowledge_graph
    const payload = await this.request<
      RagFlowResponse<{
        graph?: { nodes?: KnowledgeGraphNode[]; edges?: KnowledgeGraphEdge[] };
        mind_map?: unknown;
      }>
    >(
      `/api/v1/datasets/${datasetId}/knowledge_graph`,
      {
        method: "GET",
      },
      input.apiKey,
    );

    const data = payload.data;
    if (!data?.graph) return null;

    return {
      graph: {
        nodes: data.graph.nodes ?? [],
        edges: data.graph.edges ?? [],
      },
      mind_map: data.mind_map,
    };
  }

  async deleteKnowledgeGraph(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<void> {
    const datasetId = input.knowledgeBaseRemoteId;
    // v0.26.0 正确端点：DELETE /api/v1/datasets/{id}/knowledge_graph
    try {
      await this.request(
        `/api/v1/datasets/${datasetId}/knowledge_graph`,
        {
          method: "DELETE",
        },
        input.apiKey,
      );
    } catch (err) {
      // 图不存在时 RAGFlow 返回 code != 0，视为幂等删除
      const message = err instanceof Error ? err.message : "";
      if (message.includes("code=102")) {
        console.log("[ragflow] deleteKnowledgeGraph: graph not found, treating as success", { datasetId });
        return;
      }
      throw err;
    }
  }

  async pollKnowledgeGraphProgress(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<{ progress: number; progressMsg?: string; taskId?: string }> {
    const datasetId = input.knowledgeBaseRemoteId;
    // v0.26.0 正确端点：GET /api/v1/datasets/{id}/trace_graphrag
    const payload = await this.request<
      RagFlowResponse<{
        progress?: number;
        progress_msg?: string;
        task_id?: string;
      }>
    >(
      `/api/v1/datasets/${datasetId}/trace_graphrag`,
      {
        method: "GET",
      },
      input.apiKey,
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
