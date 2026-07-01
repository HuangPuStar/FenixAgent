import * as z from "zod/v4";
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
  createdAt: z.number().describe("资源创建时间戳，单位为秒。"),
  updatedAt: z.number().describe("资源更新时间戳，单位为秒。"),
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
  createdAt: z.number().describe("创建时间戳，单位为秒。"),
  updatedAt: z.number().describe("更新时间戳，单位为秒。"),
});

/** 创建知识库请求体 */
export const CreateKnowledgeBaseRequestSchema = z.object({
  name: z.string().min(1).describe("知识库名称。"),
  slug: z.string().min(1).optional().describe("可选的知识库 slug；未传时由服务端自动生成。"),
  description: z.string().optional().describe("知识库描述。"),
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
export const KnowledgeBaseListResponseSchema = KnowledgeBaseInfoSchema.array().describe("知识库列表。");

/** GET /web/knowledgeBases/:id — 知识库详情响应 */
export const KnowledgeBaseDetailResponseSchema = KnowledgeBaseInfoSchema.describe("知识库详情。");

/** GET /web/knowledgeBases/:id/resources — 资源列表响应 */
export const KnowledgeResourceListResponseSchema = KnowledgeResourceItemSchema.array().describe("知识资源列表。");

/** POST /web/knowledgeBases/:id/resources/upload — 上传资源响应 */
export const UploadKnowledgeResourcesResponseSchema = z.object({
  items: KnowledgeResourceItemSchema.array().describe("本次上传后的资源列表。"),
});

/** POST /web/knowledgeBases/:id/resources/url — 导入 URL 响应 */
export const ImportKnowledgeUrlResponseSchema = KnowledgeResourceItemSchema.describe("URL 导入后的知识资源。");

export type KnowledgeBaseInfo = z.infer<typeof KnowledgeBaseInfoSchema>;
export type KnowledgeResourceItem = z.infer<typeof KnowledgeResourceItemSchema>;
export type CreateKnowledgeBaseRequest = z.infer<typeof CreateKnowledgeBaseRequestSchema>;
export type UpdateKnowledgeBaseRequest = z.infer<typeof UpdateKnowledgeBaseRequestSchema>;
export type KnowledgeBaseListResponse = z.infer<typeof KnowledgeBaseListResponseSchema>;
export type KnowledgeBaseDetailResponse = z.infer<typeof KnowledgeBaseDetailResponseSchema>;
export type KnowledgeResourceListResponse = z.infer<typeof KnowledgeResourceListResponseSchema>;
export type UploadKnowledgeResourcesResponse = z.infer<typeof UploadKnowledgeResourcesResponseSchema>;
export type ImportKnowledgeUrlResponse = z.infer<typeof ImportKnowledgeUrlResponseSchema>;
