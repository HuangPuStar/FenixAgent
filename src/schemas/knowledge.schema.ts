import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";
/** 知识库状态 */
export const KnowledgeBaseStatusSchema = z.enum(["empty", "indexing", "ready", "error"]).describe("知识库状态。");

/** 知识资源状态 */
export const KnowledgeResourceStatusSchema = z
  .enum(["pending", "processing", "ready", "error"])
  .describe("知识资源处理状态。");

/** 知识资源项 */
export const KnowledgeResourceItemSchema = z.object({
  id: z.string().describe("资源 ID。"),
  knowledgeBaseId: z.string().optional().describe("所属知识库 ID。"),
  sourceName: z.string().describe("资源名称。"),
  sourceType: z.string().describe("资源来源类型，例如 upload、url。"),
  sourcePath: z.string().nullable().optional().describe("资源源文件路径；URL 导入或无本地路径时为 null。"),
  remoteId: z.string().nullable().optional().describe("远端资源 ID；未同步时为 null。"),
  status: KnowledgeResourceStatusSchema,
  lastError: z.string().nullable().describe("最近一次错误信息；无错误时为 null。"),
  enabled: z.boolean().nullable().optional().describe("远端是否启用；未从远端同步时为 null。"),
  chunkCount: z.number().nullable().optional().describe("分块数。"),
  metaFields: z.record(z.string(), z.unknown()).nullable().optional().describe("元数据字段。"),
  parseProgress: z.number().nullable().optional().describe("解析进度百分比(0-100)。"),
  runStatus: z.string().nullable().optional().describe("远端运行状态：UNSTART/RUNNING/DONE/FAIL。"),
  chunkMethod: z.string().nullable().optional().describe("分块方法标识。"),
  fileSize: z.number().nullable().optional().describe("文件大小(字节)。"),
  createdAt: z.number().describe("资源创建时间戳，单位为秒。"),
  updatedAt: z.number().describe("资源更新时间戳，单位为秒。"),
});

/** 知识库解析方法：内置分块器或自定义 pipeline */
export const KnowledgeParseMethodSchema = z
  .enum(["builtin", "pipeline"])
  .describe("解析方法：builtin=内置分块器，pipeline=自定义解析流水线。");

/** 嵌入模型选项（创建表单下拉） */
export const EmbeddingModelOptionSchema = z.object({
  name: z.string().describe("RagFlow 模型标识，透传给 dataset 的 embedding_model 字段。"),
  label: z.string().describe("展示名。"),
  provider: z.string().describe("厂商名，用于前端分组展示。"),
  instance: z.string().describe("实例名，用于前端分组展示。"),
});

/** 分块方法选项（创建表单下拉，对应 RagFlow v0.26 chunk_method） */
export const ChunkMethodOptionSchema = z.object({
  value: z.string().describe("RagFlow chunk_method，如 naive/book/paper。"),
  label: z.string().describe("RagFlow parser_ids 原生展示名，如 General/Book/Paper。"),
  labelKey: z.string().optional().describe("@deprecated 前端 i18n 查表用的本地化键（向后兼容）。"),
});

/** pipeline 选项（创建表单下拉，best-effort） */
export const KnowledgePipelineOptionSchema = z.object({
  id: z.string().describe("pipeline 标识。"),
  name: z.string().describe("pipeline 展示名。"),
});

/** 创建知识库表单所需的全部可选项 */
export const KnowledgeFormOptionsSchema = z.object({
  embeddingModels: EmbeddingModelOptionSchema.array().describe("可用的嵌入模型列表。"),
  chunkMethods: ChunkMethodOptionSchema.array().describe("内置分块方法列表。"),
  pipelines: KnowledgePipelineOptionSchema.array().describe("可用的解析 pipeline 列表。"),
});

/** 知识库信息 */
export const KnowledgeBaseInfoSchema = z.object({
  id: z.string().describe("知识库 ID。"),
  name: z.string().describe("知识库名称。"),
  slug: z.string().describe("知识库 slug。"),
  description: z.string().nullable().describe("知识库描述；未填写时为 null。"),
  provider: z.string().nullable().describe("知识提供方名称。"),
  remoteId: z.string().nullable().describe("远端知识库 ID；未同步时为 null。"),
  remoteAccountId: z.string().nullable().describe("远端账户 ID；未同步时为 null。"),
  remoteUserId: z.string().nullable().describe("远端用户 ID；未同步时为 null。"),
  status: KnowledgeBaseStatusSchema,
  lastError: z.string().nullable().describe("最近一次错误信息；无错误时为 null。"),
  bindingsCount: z.number().describe("绑定到 Agent 的数量。"),
  resourcesCount: z.number().describe("知识资源数量。"),
  recentResources: KnowledgeResourceItemSchema.array().describe("最近的知识资源列表。"),
  embeddingModel: z.string().nullable().optional().describe("创建时选定的嵌入模型；未指定时为 null。创建后不可修改。"),
  parseMethod: KnowledgeParseMethodSchema.nullable().optional().describe("创建时选定的解析方法；未指定时为 null。"),
  chunkMethod: z.string().nullable().optional().describe("创建时选定的分块方法 chunk_method；未指定时为 null。"),
  createdAt: z.number().describe("创建时间戳，单位为秒。"),
  updatedAt: z.number().describe("更新时间戳，单位为秒。"),
});

/** 创建知识库请求体 */
export const CreateKnowledgeBaseRequestSchema = z.object({
  name: z.string().min(1).describe("知识库名称。"),
  slug: z.string().min(1).optional().describe("可选的知识库 slug；未传时由服务端自动生成。"),
  description: z.string().optional().describe("知识库描述。"),
  embeddingModel: z.string().optional().describe("嵌入模型名；未传时由 RagFlow 使用租户默认模型。创建后不可修改。"),
  parseMethod: KnowledgeParseMethodSchema.optional().describe("解析方法；未传时不记录。创建后不可修改。"),
  pipelineId: z
    .string()
    .nullable()
    .optional()
    .describe("自定义解析 pipeline ID（dataflow canvas ID）；仅 parseMethod=pipeline 时生效。"),
  chunkMethod: z
    .string()
    .optional()
    .describe("内置分块方法 chunk_method；仅 parseMethod=builtin 时生效。创建后不可修改。"),
});

/** 更新知识库请求体 */
export const UpdateKnowledgeBaseRequestSchema = z.object({
  name: z.string().min(1).optional().describe("更新后的知识库名称。"),
  slug: z.string().min(1).optional().describe("更新后的知识库 slug。"),
  description: z.string().optional().describe("更新后的知识库描述。"),
});

/** URL 导入请求体 */
export const ImportKnowledgeUrlRequestSchema = z.object({
  url: z.string().url("url 为必填字段").describe("要导入的 URL。"),
  sourceName: z.string().optional().describe("可选的资源名称。"),
});

/** GET /web/knowledgeBases — 知识库列表响应 */
export const KnowledgeBaseListResponseSchema = WebOkSchema(
  KnowledgeBaseInfoSchema.array().describe("知识库列表。"),
).describe("知识库列表响应。");

/** GET /web/knowledgeBases/:id — 知识库详情响应 */
export const KnowledgeBaseDetailResponseSchema = WebOkSchema(KnowledgeBaseInfoSchema.describe("知识库详情。")).describe(
  "知识库详情响应。",
);

/** GET /web/knowledgeBases/:id/resources — 资源列表响应 */
export const KnowledgeResourceListResponseSchema = WebOkSchema(
  KnowledgeResourceItemSchema.array().describe("知识资源列表。"),
).describe("知识资源列表响应。");

/** POST /web/knowledgeBases/:id/resources/upload — 上传资源响应 */
export const UploadKnowledgeResourcesResponseSchema = WebOkSchema(
  z.object({
    items: KnowledgeResourceItemSchema.array().describe("本次上传后的资源列表。"),
  }),
).describe("上传资源响应。");

/** POST /web/knowledgeBases/:id/resources/url — 导入 URL 响应 */
export const ImportKnowledgeUrlResponseSchema = WebOkSchema(
  KnowledgeResourceItemSchema.describe("URL 导入后的知识资源。"),
).describe("URL 导入响应。");

/** GET /web/knowledgeBases/form-options — 创建表单可选项响应 */
export const KnowledgeFormOptionsResponseSchema = WebOkSchema(
  KnowledgeFormOptionsSchema.describe("创建知识库表单所需的全部可选项。"),
).describe("创建表单可选项响应。");

/** rerank 重排序模型选项（检索测试用，结构与 EmbeddingModelOption 一致） */
export const RerankModelOptionSchema = z.object({
  name: z.string().describe("RagFlow 模型标识，三段式 name@instance@provider。"),
  label: z.string().describe("展示名。"),
  provider: z.string().describe("厂商名，用于前端分组展示。"),
  instance: z.string().describe("实例名，用于前端分组展示。"),
});

/** GET /web/knowledgeBases/rerank-models 响应 */
export const RerankModelsResponseSchema = WebOkSchema(
  z.array(RerankModelOptionSchema).describe("可用的 rerank 模型列表。"),
).describe("rerank 模型列表响应。");

/** POST /web/knowledgeBases/:id/search — 检索测试请求体 */
export const KnowledgeSearchBodySchema = z.object({
  query: z.string().min(1).describe("检索查询文本。"),
  similarityThreshold: z.number().min(0).max(1).optional().describe("相似度阈值，0~1，低于此分的 chunk 被过滤。"),
  vectorSimilarityWeight: z.number().min(0).max(1).optional().describe("向量相似度权重，0~1，全文权重 = 1 - 此值。"),
  rerankId: z.string().nullable().optional().describe("rerank 重排序模型 ID（三段式 name@instance@provider）。"),
  keyword: z.boolean().optional().describe("是否启用关键词匹配增强。"),
  highlight: z.boolean().optional().describe("是否返回高亮内容，默认 true。"),
  pageSize: z.number().int().min(1).max(100).optional().describe("每页返回 chunk 数。"),
  page: z.number().int().min(1).optional().describe("页码，从 1 开始。"),
  topK: z.number().int().min(1).max(2048).optional().describe("Top K 候选数（选择 rerank 模型后可见），默认 1024。"),
  useKg: z.boolean().optional().describe("是否启用知识图谱多跳检索。"),
  crossLanguages: z.array(z.string()).optional().describe('跨语言检索目标语言列表，如 ["English","Chinese"]。'),
  metaDataFilter: z
    .object({
      method: z.enum(["disabled", "auto", "semi_auto", "manual"]).describe("元数据过滤模式。"),
      logic: z.string().optional().describe('手动模式下的条件组合逻辑："and" 或 "or"。'),
      manual: z
        .array(
          z.object({
            key: z.string().describe("元数据字段名。"),
            op: z.string().describe("比较操作符，如 =、>、<、contains。"),
            value: z.union([z.string(), z.array(z.string())]).describe("比较值。"),
          }),
        )
        .optional()
        .describe("手动模式下的筛选条件列表。"),
      semi_auto: z
        .array(z.union([z.string(), z.object({ key: z.string(), op: z.string().optional() })]))
        .optional()
        .describe("半自动模式下的元数据字段选择。"),
    })
    .optional()
    .describe("元数据过滤配置（支持 4 种模式：disabled/auto/semi_auto/manual）。"),
});

/** 检索测试单个 chunk 的详细信息（含三种相似度分） */
export const KnowledgeRetrievalChunkSchema = z.object({
  chunkId: z.string().describe("chunk 远端 ID。"),
  content: z.string().describe("chunk 原文内容。"),
  documentName: z.string().describe("文档名。"),
  documentId: z.string().describe("文档远端 ID。"),
  datasetId: z.string().describe("知识库远端 ID（dataset_id）。"),
  similarity: z.number().describe("混合相似度总分（向量 + 全文加权后）。"),
  vectorSimilarity: z.number().nullable().optional().describe("向量相似度分。"),
  termSimilarity: z.number().nullable().optional().describe("词项（全文）相似度分。"),
  highlight: z.string().nullable().optional().describe("高亮内容（含 <em> 标签的 HTML）。"),
  importantKeywords: z.array(z.string()).optional().describe("关键词标签。"),
});

/** 检索测试文档维度聚合项 */
export const KnowledgeRetrievalDocAggSchema = z.object({
  documentName: z.string().describe("文档名。"),
  documentId: z.string().describe("文档远端 ID。"),
  count: z.number().describe("该文档命中的 chunk 数。"),
});

/** 检索测试详细结果 */
export const KnowledgeSearchResultDataSchema = z.object({
  chunks: z.array(KnowledgeRetrievalChunkSchema).describe("命中的 chunk 列表。"),
  total: z.number().describe("过阈值后的总命中数。"),
  docAggs: z.array(KnowledgeRetrievalDocAggSchema).describe("文档维度聚合。"),
});

/** POST /web/knowledgeBases/:id/search — 检索测试响应 */
export const KnowledgeSearchResponseSchema = WebOkSchema(
  KnowledgeSearchResultDataSchema.describe("检索测试详细结果。"),
).describe("检索测试响应。");

export type KnowledgeBaseInfo = z.infer<typeof KnowledgeBaseInfoSchema>;
export type KnowledgeResourceItem = z.infer<typeof KnowledgeResourceItemSchema>;
export type CreateKnowledgeBaseRequest = z.infer<typeof CreateKnowledgeBaseRequestSchema>;
export type UpdateKnowledgeBaseRequest = z.infer<typeof UpdateKnowledgeBaseRequestSchema>;
export type KnowledgeBaseListResponse = z.infer<typeof KnowledgeBaseListResponseSchema>;
export type KnowledgeBaseDetailResponse = z.infer<typeof KnowledgeBaseDetailResponseSchema>;
export type KnowledgeResourceListResponse = z.infer<typeof KnowledgeResourceListResponseSchema>;
export type UploadKnowledgeResourcesResponse = z.infer<typeof UploadKnowledgeResourcesResponseSchema>;
export type ImportKnowledgeUrlResponse = z.infer<typeof ImportKnowledgeUrlResponseSchema>;
export type KnowledgeFormOptions = z.infer<typeof KnowledgeFormOptionsSchema>;
export type EmbeddingModelOption = z.infer<typeof EmbeddingModelOptionSchema>;
export type ChunkMethodOption = z.infer<typeof ChunkMethodOptionSchema>;
export type KnowledgePipelineOption = z.infer<typeof KnowledgePipelineOptionSchema>;
export type KnowledgeParseMethod = z.infer<typeof KnowledgeParseMethodSchema>;
export type RerankModelOption = z.infer<typeof RerankModelOptionSchema>;
export type KnowledgeSearchBody = z.infer<typeof KnowledgeSearchBodySchema>;
export type KnowledgeRetrievalChunk = z.infer<typeof KnowledgeRetrievalChunkSchema>;
export type KnowledgeRetrievalDocAgg = z.infer<typeof KnowledgeRetrievalDocAggSchema>;
export type KnowledgeSearchResultData = z.infer<typeof KnowledgeSearchResultDataSchema>;
