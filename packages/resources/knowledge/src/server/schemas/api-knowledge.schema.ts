import * as z from "zod/v4";
import { KnowledgeBaseInfoSchema } from "./knowledge.schema";

/**
 * 对外知识库列表查询参数。
 * 先提供稳定分页结构，后续补筛选时不破坏现有调用方。
 */
export const ApiKnowledgeBaseListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).describe("页码，从 1 开始。"),
    pageSize: z.coerce.number().int().min(1).max(100).default(20).describe("每页条数，最大 100。"),
  })
  .describe("知识库列表查询参数。");

export const ApiKnowledgeBaseListItemSchema = KnowledgeBaseInfoSchema.describe("对外知识库列表项。");

export const ApiKnowledgeBaseListResponseSchema = z
  .object({
    items: z.array(ApiKnowledgeBaseListItemSchema).describe("当前页知识库列表。"),
    total: z.number().int().min(0).describe("总条数。"),
    page: z.number().int().min(1).describe("当前页码。"),
    pageSize: z.number().int().min(1).describe("当前分页大小。"),
  })
  .describe("对外知识库列表响应。");

export type ApiKnowledgeBaseListQuery = z.infer<typeof ApiKnowledgeBaseListQuerySchema>;
