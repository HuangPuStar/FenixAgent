export interface KnowledgeResourceInfo {
  id: string;
  knowledgeBaseId: string;
  sourceName: string;
  sourceType: string;
  sourcePath: string | null;
  remoteId: string | null;
  status: string;
  lastError: string | null;
  enabled?: boolean | null;
  chunkCount?: number | null;
  metaFields?: Record<string, unknown> | null;
  parseProgress?: number | null;
  runStatus?: string | null;
  chunkMethod?: string | null;
  fileSize?: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 知识库解析方法：内置分块器或自定义 pipeline */
export type KnowledgeParseMethod = "builtin" | "pipeline";

/** 创建表单可选的嵌入模型选项 */
export interface EmbeddingModelOption {
  name: string;
  label: string;
  provider: string;
  instance: string;
}

/** 创建表单可选的分块方法选项（RagFlow chunk_method） */
export interface ChunkMethodOption {
  value: string;
  label: string;
  /** @deprecated 向后兼容 */
  labelKey?: string;
}

/** 创建表单可选的 pipeline 选项 */
export interface KnowledgePipelineOption {
  id: string;
  name: string;
}

/** 创建知识库表单所需的全部可选项 */
export interface KnowledgeFormOptions {
  embeddingModels: EmbeddingModelOption[];
  chunkMethods: ChunkMethodOption[];
  pipelines: KnowledgePipelineOption[];
}

export interface KnowledgeBaseCreateBody {
  name: string;
  slug?: string;
  description?: string;
  embeddingModel?: string | null;
  parseMethod?: KnowledgeParseMethod | null;
  pipelineId?: string | null;
  chunkMethod?: string | null;
}

export interface KnowledgeBaseInfo {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  provider: string | null;
  remoteId: string | null;
  remoteAccountId: string | null;
  remoteUserId: string | null;
  status: string;
  lastError: string | null;
  bindingsCount: number;
  resourcesCount: number;

  userId: string;
  organizationId: string | null;
  embeddingModel: string | null;
  parseMethod: KnowledgeParseMethod | null;
  chunkMethod: string | null;
  remoteExists?: boolean;
  keyConfigured?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeBaseListResponse {
  items: KnowledgeBaseInfo[];
}

/** 可用厂商选项（系统目录） */
export interface EmbeddingFactoryOption {
  name: string;
  tags?: string | null;
  /** 厂商默认 base URL（OpenAI 兼容厂商可覆盖） */
  url?: string | null;
}

/** 厂商动态模型库选项 */
export interface ProviderModelOption {
  name: string;
  modelType: string;
  maxTokens?: number | null;
}

/** 实例下单个模型及其状态（来自 GET /providers/<p>/instances/<i>/models） */
export interface InstanceModelOption {
  /** 模型名 */
  name: string;
  /** 所属厂商 */
  provider: string;
  /** 所属实例 */
  instance: string;
  /** 模型类型（可能多个，逗号分隔） */
  modelType: string;
  /** 最大 token 数 */
  maxTokens?: number | null;
  /** active / inactive；inactive 时新建 KB 选不到该模型，但老 KB 不受影响 */
  status: string;
}

/** 已配置实例节点：一对 (provider, instanceName) + 其下所有模型 */
export interface ConfiguredInstanceNode {
  provider: string;
  instanceName: string;
  status: string;
  models: InstanceModelOption[];
}

/** 已配置供应商节点：provider 名 + 其下所有实例 */
export interface ConfiguredProviderNode {
  provider: string;
  instances: ConfiguredInstanceNode[];
}

/** 已配置的 embedding 模型（模型管理列表项） */
export interface ConfiguredEmbeddingModel {
  name: string;
  label: string;
  provider: string;
  instance: string;
  modelType: string;
  status?: string | null;
}

export interface UnassociatedKnowledgeBase {
  id: string;
  name: string;
}

export interface KnowledgeBaseDetail extends KnowledgeBaseInfo {
  recentResources: KnowledgeResourceInfo[];
}

export interface KnowledgeUploadResponse {
  items: KnowledgeResourceInfo[];
}

/** rerank 重排序模型选项（检索测试用） */
export interface RerankModelOption {
  name: string;
  label: string;
  provider: string;
  instance: string;
}

/** 元数据过滤 4 种模式 */
export type MetaDataFilterMethod = "disabled" | "auto" | "semi_auto" | "manual";

/** 元数据过滤手动条件项 */
export interface MetaDataFilterCondition {
  key: string;
  op: string;
  value: string | string[];
}

/** 元数据过滤配置（对应 RAGFlow meta_data_filter 字段） */
export interface MetaDataFilter {
  method: MetaDataFilterMethod;
  logic?: string;
  manual?: MetaDataFilterCondition[];
  semi_auto?: Array<string | { key: string; op?: string }>;
}

/** 检索测试请求体 */
export interface KnowledgeSearchBody {
  query: string;
  similarityThreshold?: number;
  vectorSimilarityWeight?: number;
  rerankId?: string | null;
  keyword?: boolean;
  highlight?: boolean;
  pageSize?: number;
  page?: number;
  topK?: number;
  useKg?: boolean;
  crossLanguages?: string[];
  metaDataFilter?: MetaDataFilter;
}

/** 检索测试单个 chunk 的详细信息（含三种相似度分） */
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

/** 检索测试文档维度聚合项 */
export interface KnowledgeRetrievalDocAgg {
  documentName: string;
  documentId: string;
  count: number;
}

/** 检索测试详细结果 */
export interface KnowledgeSearchResultData {
  chunks: KnowledgeRetrievalChunk[];
  total: number;
  docAggs: KnowledgeRetrievalDocAgg[];
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

/** 知识图谱数据 */
export interface KnowledgeGraphData {
  graph: {
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
  };
  mind_map?: unknown;
}

/** 知识图谱生成进度 */
export interface KnowledgeGraphProgress {
  progress: number;
  progressMsg?: string;
  taskId?: string;
}

/** 资源内的单个切片 */
export interface KnowledgeChunk {
  id: string;
  content: string;
  chunkIndex: number;
  importantKeywords: string[];
  enabled: boolean;
}

/** 切片列表分页响应 */
export interface KnowledgeChunkListResponse {
  items: KnowledgeChunk[];
  total: number;
  page: number;
  pageSize: number;
}
