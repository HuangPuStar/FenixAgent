import * as z from "zod/v4";
import { OkResponseSchema } from "./common.schema";

export const KnowledgeBaseStatusSchema = z.enum(["empty", "indexing", "ready", "error"]);
export const KnowledgeResourceStatusSchema = z.enum(["pending", "processing", "ready", "error"]);

export const KnowledgeResourceItemSchema = z.object({
  id: z.string(),
  sourceName: z.string(),
  sourceType: z.string(),
  status: KnowledgeResourceStatusSchema,
  lastError: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const KnowledgeBaseInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  provider: z.string().nullable(),
  remoteId: z.string().nullable(),
  remoteAccountId: z.string().nullable(),
  remoteUserId: z.string().nullable(),
  status: KnowledgeBaseStatusSchema,
  lastError: z.string().nullable(),
  bindingsCount: z.number(),
  resourcesCount: z.number(),
  recentResources: KnowledgeResourceItemSchema.array(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const CreateKnowledgeBaseRequestSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().optional(),
});

export const UpdateKnowledgeBaseRequestSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  description: z.string().optional(),
});

export const ImportKnowledgeUrlRequestSchema = z.object({
  url: z.string().url("url 为必填字段"),
  sourceName: z.string().optional(),
});

/** GET /web/knowledgeBases — 知识库列表响应 */
export const KnowledgeBaseListResponseSchema = KnowledgeBaseInfoSchema.array();

/** DELETE /web/knowledgeBases/:id — 删除知识库响应 */
export const DeleteKnowledgeBaseResponseSchema = OkResponseSchema;

/** POST /web/knowledgeBases/:id/resources/upload — 上传资源响应 */
export const UploadKnowledgeResourcesResponseSchema = z.object({
  items: KnowledgeResourceItemSchema.array(),
});

/** POST /web/knowledgeBases/:id/resources/url — 导入 URL 响应 */
export const ImportKnowledgeUrlResponseSchema = KnowledgeResourceItemSchema;

/** DELETE /web/knowledgeBases/:id/resources/:resourceId — 删除资源响应 */
export const DeleteKnowledgeResourceResponseSchema = OkResponseSchema;

export type KnowledgeBaseInfo = z.infer<typeof KnowledgeBaseInfoSchema>;
export type KnowledgeResourceItem = z.infer<typeof KnowledgeResourceItemSchema>;
export type CreateKnowledgeBaseRequest = z.infer<typeof CreateKnowledgeBaseRequestSchema>;
export type UpdateKnowledgeBaseRequest = z.infer<typeof UpdateKnowledgeBaseRequestSchema>;
export type KnowledgeBaseListResponse = z.infer<typeof KnowledgeBaseListResponseSchema>;
export type DeleteKnowledgeBaseResponse = z.infer<typeof DeleteKnowledgeBaseResponseSchema>;
export type UploadKnowledgeResourcesResponse = z.infer<typeof UploadKnowledgeResourcesResponseSchema>;
export type ImportKnowledgeUrlResponse = z.infer<typeof ImportKnowledgeUrlResponseSchema>;
export type DeleteKnowledgeResourceResponse = z.infer<typeof DeleteKnowledgeResourceResponseSchema>;
