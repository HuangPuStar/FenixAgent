export type KnowledgeBaseStatus = "empty" | "indexing" | "ready" | "error";
export type KnowledgeResourceStatus = "pending" | "processing" | "ready" | "error";

// ── Embedding / pipeline / form option types ──
export interface EmbeddingModelOption {
  name: string;
  label: string;
  provider: string;
  instance: string;
}
export interface RerankModelOption {
  name: string;
  label: string;
  provider: string;
  instance: string;
}
export interface KnowledgePipelineOption {
  id: string;
  name: string;
}
export interface ChunkMethodOption {
  value: string;
  label: string;
}
export interface FactoryOption {
  name: string;
  tags?: string | null;
  url?: string | null;
}
export interface ProviderModelOption {
  name: string;
  modelType: string;
  maxTokens?: number | null;
}
export interface ProviderInstanceOption {
  provider: string;
  instanceName: string;
  status: string;
}
export interface InstanceModelOption {
  name: string;
  provider: string;
  instance: string;
  modelType: string;
  maxTokens?: number | null;
  status: string;
}
export interface ConfiguredModelInfo {
  name: string;
  label: string;
  provider: string;
  instance: string;
  modelType: string;
  status?: string | null;
}
export interface ConfiguredInstanceNode {
  provider: string;
  instanceName: string;
  status: string;
  models: InstanceModelOption[];
}
export interface ConfiguredProviderNode {
  provider: string;
  instances: ConfiguredInstanceNode[];
}

// ── Knowledge graph types ──
export interface KnowledgeGraphNode {
  id: string;
  name: string;
  label?: string;
  entity_type?: string;
  weight?: number;
  description?: string;
}
export interface KnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  weight?: number;
  description?: string;
}

// ── Meta-data filter & retrieval types ──
export type MetaDataFilterMethod = "disabled" | "auto" | "semi_auto" | "manual";
export interface MetaDataFilterCondition {
  key: string;
  op: string;
  value: string | string[];
}
export interface MetaDataFilter {
  method: MetaDataFilterMethod;
  logic?: string;
  manual?: MetaDataFilterCondition[];
  semi_auto?: Array<string | { key: string; op?: string }>;
}
export interface KnowledgeRetrievalChunk {
  chunkId: string;
  content: string;
  documentName: string;
  documentId: string;
  datasetId: string;
  similarity: number;
  vectorSimilarity?: number | null;
  termSimilarity?: number | null;
  highlight?: string | null;
  importantKeywords?: string[];
}
export interface KnowledgeRetrievalDocAgg {
  documentName: string;
  documentId: string;
  count: number;
}
export interface KnowledgeRetrievalDetailedResult {
  chunks: KnowledgeRetrievalChunk[];
  total: number;
  docAggs: KnowledgeRetrievalDocAgg[];
}
export interface KnowledgeChunk {
  id: string;
  content: string;
  chunkIndex: number;
  importantKeywords: string[];
  enabled: boolean;
}

export interface KnowledgeBaseSnapshot {
  remoteId: string | null;
  name: string;
  status: KnowledgeBaseStatus;
  description?: string | null;
  lastError?: string | null;
}

export interface KnowledgeResourceSnapshot {
  remoteId: string;
  knowledgeBaseRemoteId?: string | null;
  sourceName: string;
  sourceType: string;
  status: KnowledgeResourceStatus;
  source?: string | null;
  lastError?: string | null;
  /** 分块数；当 RagFlow 尚未完成解析或接口未返回时为 null */
  chunkCount?: number | null;
  /** RagFlow 侧启用状态（1=启用, 0=禁用）；未同步时为 null */
  enabled?: boolean | null;
  /** RagFlow 原始运行状态：UNSTART/RUNNING/DONE/FAIL */
  runStatus?: string | null;
  /** 解析进度 0-1；RagFlow 未返回进度时为 null */
  parseProgress?: number | null;
}

export interface KnowledgeSearchResult {
  title: string;
  snippet: string;
  source: string;
  score: number;
  knowledgeBaseId?: string | null;
  resourceId?: string | null;
  /** 知识库名称，供 Agent 在引用链接中展示 */
  kbName?: string | null;
  /** 知识库层级标签（个人/组织/公共），供 Agent 在引用链接中展示 */
  kbLabel?: string | null;
}

export interface KnowledgeResourceContent {
  resourceId: string;
  title?: string | null;
  content: string;
  source?: string | null;
}

export interface KnowledgeProvider {
  createKnowledgeBase(input: {
    organizationId: string;
    userId: string;
    slug: string;
    name: string;
    description?: string;
  }): Promise<KnowledgeBaseSnapshot>;
  listDatasets?(input: { apiKey?: string }): Promise<Array<{ id: string; name: string }>>;
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
  setResourceEnabled?(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    enabled: boolean;
    apiKey?: string;
  }): Promise<void>;
  reparseResource?(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
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
    similarityThreshold?: number;
    vectorSimilarityWeight?: number;
    rerankId?: string | null;
    keyword?: boolean;
    highlight?: boolean;
    pageSize?: number;
    page?: number;
    useKg?: boolean;
    crossLanguages?: string[];
    metaDataFilter?: MetaDataFilter;
    apiKey?: string;
  }): Promise<KnowledgeSearchResult[]>;
  searchDetailed?(input: {
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
    useKg?: boolean;
    crossLanguages?: string[];
    metaDataFilter?: MetaDataFilter;
    apiKey?: string;
  }): Promise<KnowledgeRetrievalDetailedResult>;
  listEmbeddingModels?(apiKey?: string): Promise<EmbeddingModelOption[]>;
  listRerankModels?(apiKey?: string): Promise<RerankModelOption[]>;
  listPipelines?(apiKey?: string): Promise<KnowledgePipelineOption[]>;
  listFactories?(apiKey?: string): Promise<FactoryOption[]>;
  verifyProviderConnection?(input: {
    apiKey?: string;
    provider: string;
    providerApiKey: string;
    baseUrl?: string | null;
  }): Promise<{ success: boolean; message?: string }>;
  listProviderModels?(input: {
    apiKey?: string;
    provider: string;
    providerApiKey: string;
    baseUrl?: string | null;
    modelType?: string;
  }): Promise<ProviderModelOption[]>;
  addProviderInstance?(input: {
    apiKey?: string;
    provider: string;
    instanceName: string;
    providerApiKey: string;
    baseUrl?: string | null;
  }): Promise<{ instanceName: string }>;
  listConfiguredProviders?(apiKey?: string): Promise<string[]>;
  listProviderInstances?(input: { apiKey?: string; provider: string }): Promise<ProviderInstanceOption[]>;
  listInstanceModels?(input: {
    apiKey?: string;
    provider: string;
    instanceName: string;
  }): Promise<InstanceModelOption[]>;
  setModelStatus?(input: {
    apiKey?: string;
    provider: string;
    instanceName: string;
    modelName: string;
    status: "active" | "inactive";
  }): Promise<void>;
  deleteProviderInstance?(input: { apiKey?: string; provider: string; instanceName: string }): Promise<void>;
  generateKnowledgeGraph?(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<void>;
  getKnowledgeGraph?(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<{ graph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }; mind_map?: unknown } | null>;
  deleteKnowledgeGraph?(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    apiKey?: string;
  }): Promise<void>;
  pollKnowledgeGraphProgress?(input: {
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
  downloadResource?(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    apiKey?: string;
  }): Promise<{ content: ReadableStream<Uint8Array>; contentType: string; fileName: string } | null>;
  getResourceProgress?(input: {
    resourceRemoteIds: string[];
    apiKey?: string;
  }): Promise<Array<{ resourceRemoteId: string; progress: number; progressMsg?: string }>>;
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
