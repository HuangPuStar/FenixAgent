import * as z from "zod/v4";

/** MCP Knowledge 入口鉴权头 */
export const McpKnowledgeAuthHeadersSchema = z
  .object({
    authorization: z.string().describe("环境密钥鉴权头，格式为 `Bearer <environment_secret>`。"),
  })
  .describe("MCP Knowledge 服务鉴权请求头。");

/** kb_search 工具输入 */
export const McpKnowledgeSearchToolInputSchema = z
  .object({
    query: z.string().min(1).describe("搜索查询文本。"),
    topK: z.number().int().min(1).max(20).optional().describe("返回结果数量上限；默认 5。"),
  })
  .describe("`kb_search` 工具输入。");

/** kb_read 工具输入 */
export const McpKnowledgeReadToolInputSchema = z
  .object({
    resourceId: z.string().min(1).describe("要读取的知识资源 ID。"),
  })
  .describe("`kb_read` 工具输入。");
