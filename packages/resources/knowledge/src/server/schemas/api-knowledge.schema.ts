import * as z from "zod/v4";
/** Frozen v1 query, independent of console status and metadata DTOs. */
export const ApiKnowledgeBaseListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();
/** Only current-organization resource facts and checked remote availability. */
export const ApiKnowledgeBaseListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  provider: z.string(),
  status: z.enum(["empty", "indexing", "ready", "error"]),
  resourcesCount: z.number().int(),
  bindingsCount: z.number().int(),
  embeddingModel: z.string().nullable(),
  parseMethod: z.string().nullable(),
  chunkMethod: z.string().nullable(),
  remoteExists: z.boolean().nullable(),
});
/** Paginated result of the same organization predicate. */
export const ApiKnowledgeBaseListResponseSchema = z.object({
  items: z.array(ApiKnowledgeBaseListItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type ApiKnowledgeBaseListQuery = z.infer<typeof ApiKnowledgeBaseListQuerySchema>;
