export type KnowledgeBaseStatus = "empty" | "indexing" | "ready" | "error";
export type KnowledgeResourceStatus = "pending" | "processing" | "ready" | "error";

/** 知识库解析方法：内置分块器或自定义 pipeline */
export type KnowledgeParseMethod = "builtin" | "pipeline";

/** 创建表单可选的嵌入模型选项 */
export interface EmbeddingModelOption {
  /** RagFlow 模型标识，透传给 dataset 的 embedding_model 字段（name@instance@provider） */
  name: string;
  /** 展示名 */
  label: string;
  /** 厂商名，用于分组展示 */
  provider: string;
  /** 实例名，用于分组展示 */
  instance: string;
}

/** 创建表单可选的分块方法选项（RagFlow v0.26 chunk_method 枚举） */
export interface ChunkMethodOption {
  /** RagFlow chunk_method，如 naive/book/paper */
  value: string;
  /** RagFlow parser_ids 原生展示名，如 General/Book/Paper */
  label: string;
  /** @deprecated 保留 labelKey 向后兼容，新代码优先用 label */
  labelKey?: string;
}

/** 创建表单可选的 pipeline 选项（远端自定义解析流水线） */
export interface KnowledgePipelineOption {
  id: string;
  name: string;
}

/** 知识库创建表单所需的全部可选项 */
export interface KnowledgeFormOptions {
  embeddingModels: EmbeddingModelOption[];
  chunkMethods: ChunkMethodOption[];
  pipelines: KnowledgePipelineOption[];
}

export interface KnowledgeBaseSnapshot {
  remoteId: string | null;
  name: string;
  status: KnowledgeBaseStatus;
  description?: string | null;
  lastError?: string | null;
  /** 创建时选定的嵌入模型（透传给 RagFlow） */
  embeddingModel?: string | null;
  /** 创建时选定的分块方法 chunk_method */
  chunkMethod?: string | null;
}

export interface KnowledgeResourceSnapshot {
  remoteId: string;
  knowledgeBaseRemoteId?: string | null;
  sourceName: string;
  sourceType: string;
  status: KnowledgeResourceStatus;
  source?: string | null;
  lastError?: string | null;
  /** RAGFlow 文档启用状态: 1=启用, 0=禁用 */
  enabled?: boolean | null;
  /** 已解析分块数 */
  chunkCount?: number | null;
  /** 元数据字段 */
  metaFields?: Record<string, unknown> | null;
  /** 解析进度 0-100 */
  parseProgress?: number | null;
  /** RAGFlow run 状态原文 */
  runStatus?: string | null;
  /** 解析方法（chunk_method 或 pipeline） */
  chunkMethod?: string | null;
  /** 文件大小（字节） */
  fileSize?: number | null;
}

export interface KnowledgeSearchResult {
  title: string;
  snippet: string;
  source: string;
  score: number;
  knowledgeBaseId?: string | null;
  resourceId?: string | null;
  /** 知识库名称（用户可见） */
  kbName?: string | null;
}

/** rerank 重排序模型选项（检索测试用，结构与 EmbeddingModelOption 一致） */
export interface RerankModelOption {
  /** RagFlow 模型标识，三段式 name@instance@provider */
  name: string;
  /** 展示名 */
  label: string;
  /** 厂商名，用于分组展示 */
  provider: string;
  /** 实例名，用于分组展示 */
  instance: string;
}

/** RAGFlow 可用厂商（供应商）选项，来自 GET /api/v1/providers?available=true */
export interface FactoryOption {
  /** 厂商名，如 OpenAI / Tongyi-Qianwen / SILICONFLOW */
  name: string;
  /** 厂商标签（支持的能力类型，如 LLM,TEXT EMBEDDING,RERANK） */
  tags?: string | null;
  /** 厂商默认 base URL（来自 RAGFlow llm_factories 配置，OpenAI 兼容厂商可覆盖） */
  url?: string | null;
}

/** 厂商动态模型库选项，来自 GET /api/v1/providers/<name>/models?api_key=... */
export interface ProviderModelOption {
  /** 模型名 */
  name: string;
  /** 模型类型：chat / embedding / rerank / image2text / speech2text / tts */
  modelType: string;
  /** 最大 token 数（可选） */
  maxTokens?: number | null;
}

/** 租户已配置的供应商实例（一组 API Key 的载体），来自 GET /api/v1/providers/<name>/instances */
export interface ProviderInstanceOption {
  /** 厂商名 */
  provider: string;
  /** 实例名（用户添加时指定） */
  instanceName: string;
  /** 实例状态：active / inactive */
  status: string;
  /** 区域（部分厂商需要，如 AWS） */
  region?: string | null;
}

/** 实例下单个模型及其状态，来自 GET /api/v1/providers/<name>/instances/<instance>/models */
export interface InstanceModelOption {
  /** 模型名 */
  name: string;
  /** 所属厂商 */
  provider: string;
  /** 所属实例 */
  instance: string;
  /** 模型类型（embedding/chat/rerank...，可能多个用逗号分隔） */
  modelType: string;
  /** 最大 token 数 */
  maxTokens?: number | null;
  /** active / inactive；inactive 时新建 KB 选不到该模型，但老 KB 不受影响 */
  status: string;
}

/** 已配置的 embedding 模型（租户已添加），用于模型管理列表展示 */
export interface ConfiguredModelInfo {
  /** RagFlow 模型标识（三段式 name@instance@provider，或旧版 name@provider） */
  name: string;
  /** 展示名 */
  label: string;
  /** 厂商名 */
  provider: string;
  /** 实例名 */
  instance: string;
  /** 模型类型（embedding/rerank/chat 等） */
  modelType: string;
  /** 状态：active/inactive 或其他 RagFlow 原文 */
  status?: string | null;
}

/** 检索测试场景下单个 chunk 的详细信息（保留 RAGFlow 返回的完整字段） */
export interface KnowledgeRetrievalChunk {
  /** chunk 远端 ID */
  chunkId: string;
  /** chunk 原文内容 */
  content: string;
  /** 文档名 */
  documentName: string;
  /** 文档远端 ID */
  documentId: string;
  /** 知识库远端 ID（dataset_id） */
  datasetId: string;
  /** 混合相似度总分（向量 + 全文加权后） */
  similarity: number;
  /** 向量相似度分（可能为空，取决于 RAGFlow 是否返回） */
  vectorSimilarity?: number;
  /** 词项（全文）相似度分（可能为空） */
  termSimilarity?: number;
  /** 高亮内容（含 <em> 标签的 HTML），无高亮时为空 */
  highlight?: string;
  /** 关键词标签 */
  importantKeywords?: string[];
}

/** 检索测试文档维度聚合项，用于结果按文档筛选 */
export interface KnowledgeRetrievalDocAgg {
  documentName: string;
  documentId: string;
  /** 该文档命中的 chunk 数 */
  count: number;
}

/** 元数据过滤 4 种模式：禁用 / 自动 / 半自动 / 手动 */
export type MetaDataFilterMethod = "disabled" | "auto" | "semi_auto" | "manual";

/** 元数据过滤手动条件项 */
export interface MetaDataFilterCondition {
  key: string;
  op: string;
  value: string | string[];
}

/** 元数据过滤配置（对应 RAGFlow meta_data_filter 字段） */
export interface MetaDataFilter {
  /** 过滤模式 */
  method: MetaDataFilterMethod;
  /** 手动模式下的条件组合逻辑：and / or */
  logic?: string;
  /** 手动模式：直接提供筛选条件 */
  manual?: MetaDataFilterCondition[];
  /** 半自动模式：指定的元数据字段名或字段+可选操作符约束 */
  semi_auto?: Array<string | { key: string; op?: string }>;
}

/** 检索测试详细结果，由 searchDetailed() 返回 */
export interface KnowledgeRetrievalDetailedResult {
  chunks: KnowledgeRetrievalChunk[];
  /** 过阈值后的总命中数 */
  total: number;
  /** 文档维度聚合 */
  docAggs: KnowledgeRetrievalDocAgg[];
}

export interface KnowledgeResourceContent {
  resourceId: string;
  title?: string | null;
  content: string;
  source?: string | null;
  /** 文档类型（如 pdf、xlsx、md 等），来自 RAGFlow */
  docType?: string | null;
  /** 解析后的分块数量，为 0 表示尚未解析或解析失败 */
  chunkCount?: number;
}

/** 知识图谱节点 */
export interface KnowledgeGraphNode {
  id: string;
  name: string;
  label?: string;
  entity_type?: string;
  weight?: number;
  description?: string;
}

/** 知识图谱边 */
export interface KnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  weight?: number;
  description?: string;
}

/** 资源内的单个切片（chunk），来自 RAGFlow chunks API */
export interface KnowledgeChunk {
  /** RAGFlow chunk ID */
  id: string;
  /** 切片文本内容 */
  content: string;
  /** 切片在文档中的序号 */
  chunkIndex: number;
  /** 提取的重要关键词 */
  importantKeywords: string[];
  /** 启用状态 */
  enabled: boolean;
}

export interface KnowledgeProvider {
  createKnowledgeBase(input: {
    organizationId: string;
    userId: string;
    slug: string;
    name: string;
    description?: string;
    /** 嵌入模型名；缺省时由 RagFlow 使用租户默认模型 */
    embeddingModel?: string | null;
    /** 解析方法：1=内置分块器(BuiltIn) / 2=自定义pipeline(Pipeline) */
    parseType?: number | null;
    /** 自定义解析 pipeline ID（仅 parseType=2 时生效） */
    pipelineId?: string | null;
    /** 分块方法 chunk_method；缺省时 RagFlow 使用 naive */
    chunkMethod?: string | null;
    apiKey?: string;
  }): Promise<KnowledgeBaseSnapshot>;
  /** 列出上游可用的数据集列表（用于未关联 KB 导入） */
  listDatasets(input: { apiKey?: string }): Promise<Array<{ id: string; name: string }>>;
  /** 获取单个数据集详情（用于导入时同步嵌入模型、分块方法等配置） */
  getDataset?(input: { datasetId: string; apiKey?: string }): Promise<{
    embeddingModel?: string | null;
    chunkMethod?: string | null;
    parseMethod?: string | null;
  } | null>;
  /**
   * 列出上游可用的嵌入模型，供创建知识库表单选择。
   * 实现应在上游不可用时返回空数组，避免阻断表单渲染。
   */
  listEmbeddingModels(apiKey?: string): Promise<EmbeddingModelOption[]>;
  /**
   * 列出上游可用的 rerank 重排序模型，供检索测试选择。
   * 上游不可用时返回空数组。
   */
  listRerankModels(apiKey?: string): Promise<RerankModelOption[]>;
  /** 列出 RAGFlow 可用厂商（系统目录），用于添加 embedding 模型时选厂商 */
  listFactories?(apiKey?: string): Promise<FactoryOption[]>;
  /** 验证厂商 API Key 是否可用（实时测试） */
  verifyProviderConnection?(input: {
    apiKey?: string;
    provider: string;
    providerApiKey: string;
    baseUrl?: string | null;
  }): Promise<{ success: boolean; message?: string }>;
  /** 动态列出厂商模型库（用 api_key 临时访问） */
  listProviderModels?(input: {
    apiKey?: string;
    provider: string;
    providerApiKey: string;
    baseUrl?: string | null;
    modelType?: string;
  }): Promise<ProviderModelOption[]>;
  /** 添加厂商实例（写入租户配置） */
  addProviderInstance?(input: {
    apiKey?: string;
    provider: string;
    instanceName: string;
    providerApiKey: string;
    baseUrl?: string | null;
  }): Promise<{ instanceName: string }>;
  /** 列出当前租户已配置的供应商名单（不含系统目录全集） */
  listConfiguredProviders?(apiKey?: string): Promise<string[]>;
  /** 列出某供应商下租户已配置的实例 */
  listProviderInstances?(input: { apiKey?: string; provider: string }): Promise<ProviderInstanceOption[]>;
  /** 列出某实例下的全部模型（含 active/inactive 状态，不过滤 inactive） */
  listInstanceModels?(input: {
    apiKey?: string;
    provider: string;
    instanceName: string;
  }): Promise<InstanceModelOption[]>;
  /** 切换实例下单个模型的 active/inactive 状态（屏蔽模型用） */
  setModelStatus?(input: {
    apiKey?: string;
    provider: string;
    instanceName: string;
    modelName: string;
    status: "active" | "inactive";
  }): Promise<void>;
  /**
   * 删除一个 provider 实例（含其下所有模型配置）。
   * 删除粒度是「实例」，不是单个模型、也不是整个供应商。
   */
  deleteProviderInstance?(input: { apiKey?: string; provider: string; instanceName: string }): Promise<void>;
  /** 列出已配置的 embedding 模型（带 status 字段，供模型管理列表） */
  listConfiguredEmbeddingModels?(apiKey?: string): Promise<ConfiguredModelInfo[]>;
  /**
   * 列出上游可用的自定义解析 pipeline（best-effort）。
   * 不支持 pipeline 的上游或调用失败时返回空数组。
   */
  listPipelines(apiKey?: string): Promise<KnowledgePipelineOption[]>;
  /** 删除整个知识库；RagFlow 不同版本可能使用单资源路径或集合端点。 */
  deleteKnowledgeBase(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<void>;
  addResource(input: {
    knowledgeBaseRemoteId?: string | null;
    targetRemoteId?: string | null;
    remoteAccountId: string;
    remoteUserId: string;
    filePath?: string;
    url?: string;
    sourceName?: string;
    wait?: boolean;
    apiKey?: string;
  }): Promise<KnowledgeResourceSnapshot>;
  listResources(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<KnowledgeResourceSnapshot[]>;
  /** 启用/禁用文档（RAGFlow batch-update-status） */
  setResourceEnabled(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    enabled: boolean;
    apiKey?: string;
  }): Promise<void>;
  /** 触发文档重新解析（RAGFlow ingest API），后端仅触发不等待完成 */
  reparseResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    /** 重新解析前是否删除已有分块数据 */
    deleteOld: boolean;
    apiKey?: string;
  }): Promise<void>;
  deleteResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    recursive?: boolean;
    apiKey?: string;
  }): Promise<void>;
  search(input: {
    knowledgeBases: Array<{
      remoteId: string;
      remoteAccountId: string;
      remoteUserId: string;
    }>;
    query: string;
    topK: number;
    /** 相似度阈值，0~1，低于此分的 chunk 被过滤；缺省时由 RagFlow 用默认值（0.2） */
    similarityThreshold?: number;
    /** 向量相似度权重，0~1，全文权重 = 1 - 此值；缺省时由 RagFlow 用默认值（0.3） */
    vectorSimilarityWeight?: number;
    /** rerank 重排序模型 ID（三段式 name@instance@provider）；不传则不做 rerank */
    rerankId?: string | null;
    /** 是否用 LLM 抽取 query 关键词增强检索 */
    keyword?: boolean;
    /** 是否返回 highlight 高亮字段 */
    highlight?: boolean;
    /** 每页返回 chunk 数 */
    pageSize?: number;
    /** 页码，从 1 开始 */
    page?: number;
    /** 是否启用知识图谱多跳检索 */
    useKg?: boolean;
    /** 跨语言检索：将 query 翻译为这些语言后拼接检索 */
    crossLanguages?: string[];
    /** 元数据过滤配置（支持 4 种模式：disabled/auto/semi_auto/manual） */
    metaDataFilter?: MetaDataFilter;
    apiKey?: string;
  }): Promise<KnowledgeSearchResult[]>;
  /**
   * 检索测试专用：返回保留 RAGFlow 完整字段的详细结果（三种相似度、高亮、文档聚合）。
   * 供知识库详情页检索测试 UI 使用，不影响 agent 检索链路。
   */
  searchDetailed(input: {
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
    /** 是否启用知识图谱多跳检索 */
    useKg?: boolean;
    /** 跨语言检索：将 query 翻译为这些语言后拼接检索 */
    crossLanguages?: string[];
    /** 元数据过滤配置（支持 4 种模式：disabled/auto/semi_auto/manual） */
    metaDataFilter?: MetaDataFilter;
    apiKey?: string;
  }): Promise<KnowledgeRetrievalDetailedResult>;
  /** 生成知识图谱（触发后台 GraphRAG 流水线） */
  generateKnowledgeGraph(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<void>;
  /** 获取知识图谱数据（节点 + 边），不存在时返回 null */
  getKnowledgeGraph(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<{ graph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }; mind_map?: unknown } | null>;
  /** 删除知识图谱 */
  deleteKnowledgeGraph(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<void>;
  /** 轮询知识图谱生成进度，返回 0~1 的进度值 */
  pollKnowledgeGraphProgress(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<{ progress: number; progressMsg?: string; taskId?: string }>;
  readResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<KnowledgeResourceContent>;
  /** 从 RAGFlow 下载原始文件（二进制流），不存在时返回 null */
  downloadResource?(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    apiKey?: string;
  }): Promise<{ content: ReadableStream<Uint8Array>; contentType: string; fileName: string } | null>;
  /**
   * 分页拉取资源内的切片列表（含关键词）。
   * 供资源切片查看页面使用。
   */
  listChunks(input: {
    knowledgeBaseRemoteId: string;
    resourceRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    page: number;
    pageSize: number;
    keyword?: string;
    apiKey?: string;
  }): Promise<{ items: KnowledgeChunk[]; total: number; page: number; pageSize: number }>;

  /**
   * 切换单个切片的启用/禁用状态。
   * 调用 RAGFlow PATCH /api/v1/datasets/{id}/documents/{doc_id}/chunks/{chunk_id}，
   * 传 { available: 0|1 }。
   */
  switchChunk(input: {
    knowledgeBaseRemoteId: string;
    resourceRemoteId: string;
    chunkId: string;
    available: boolean;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<void>;
}
