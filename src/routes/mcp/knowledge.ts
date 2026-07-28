import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import Elysia from "elysia";
import * as z from "zod/v4";
import { errorResponse } from "../../plugins/auth";
import { McpKnowledgeAuthHeadersSchema } from "../../schemas";
import { getEnvironmentBySecret } from "../../services/environment";
import {
  getKnowledgeGraphForAgent,
  readKnowledgeResourceForAgent,
  searchKnowledgeDetailedForAgent,
} from "../../services/knowledge-runtime";

function getBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function createKnowledgeMcpServer(environment: {
  agentConfigId: string | null;
  userId: string | null;
  organizationId: string | null;
  secret: string;
}) {
  const server = new McpServer({
    name: "kb-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "kb_search",
    {
      description:
        "在 Agent 绑定的知识库中进行语义检索。返回结果中每条包含：title（文档名）、kbName（知识库名称）、snippet（命中内容）、score（相关度）、resourceId（文档ID，用于 citation 链接）、knowledgeBaseId（知识库ID，用于 citation 链接）。支持相似度阈值、向量/关键词权重、Rerank 重排序、跨语言检索、知识图谱增强检索、元数据过滤等高级参数。回答时请使用 /citation/ 链接格式标注来源，例如：[📎 合同库·模板.pdf](/citation/{resourceId}/{knowledgeBaseId})",
      inputSchema: {
        query: z.string().min(1).describe("检索查询文本，支持自然语言。"),
        topK: z.number().int().min(1).max(50).optional().describe("返回的 top 结果数量，默认 5，最大 50。"),
        similarityThreshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("相似度阈值 (0~1)，低于此值的 chunk 被过滤，默认 0.2。"),
        vectorSimilarityWeight: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("向量检索权重 (0~1)，关键词权重 = 1 - 此值，默认 0.3。"),
        rerankId: z
          .string()
          .optional()
          .describe("Rerank 重排序模型 ID，格式为 <name>@<instance>@<provider>，不传则不进行重排序。"),
        keyword: z.boolean().optional().describe("是否启用 LLM 关键词提取增强检索，默认 false。"),
        useKg: z.boolean().optional().describe("是否启用知识图谱多跳增强检索，默认 false。"),
        crossLanguages: z
          .array(z.string())
          .optional()
          .describe("跨语言检索目标语言列表，如 ['Chinese','English','Japanese']，将 query 翻译后拼接检索。"),
        metaDataFilter: z
          .object({
            method: z
              .enum(["disabled", "auto", "semi_auto", "manual"])
              .describe("过滤模式：disabled=禁用，auto=自动，semi_auto=半自动，manual=手动"),
            logic: z.string().optional().describe("手动模式下的条件组合逻辑：and / or"),
            manual: z
              .array(
                z.object({
                  key: z.string(),
                  op: z.string(),
                  value: z.union([z.string(), z.array(z.string())]),
                }),
              )
              .optional()
              .describe("手动模式下的过滤条件列表"),
            semi_auto: z
              .array(z.union([z.string(), z.object({ key: z.string(), op: z.string().optional() })]))
              .optional()
              .describe("半自动模式下指定的元数据字段"),
          })
          .optional()
          .describe("元数据过滤配置，支持 4 种模式。manual 模式需提供 key/op/value 条件数组。"),
      },
    },
    async (params) => {
      if (!environment.agentConfigId) {
        throw new Error("Environment agent is not configured");
      }
      const results = await searchKnowledgeDetailedForAgent({
        agentConfigId: environment.agentConfigId,
        query: params.query,
        topK: params.topK ?? 5,
        userId: environment.userId ?? undefined,
        organizationId: environment.organizationId ?? undefined,
        similarityThreshold: params.similarityThreshold,
        vectorSimilarityWeight: params.vectorSimilarityWeight,
        rerankId: params.rerankId,
        keyword: params.keyword,
        useKg: params.useKg,
        crossLanguages: params.crossLanguages,
        metaDataFilter: params.metaDataFilter as Parameters<
          typeof searchKnowledgeDetailedForAgent
        >[0]["metaDataFilter"],
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ results }) }],
        structuredContent: { results },
      };
    },
  );

  server.registerTool(
    "kb_read",
    {
      description:
        "读取 Agent 已绑定知识库中指定资源（文档）的完整解析内容。支持所有 RAGFlow 能解析的文档类型（PDF、Word、Excel、PPT、Markdown、TXT、HTML 等），返回解析后的文本内容及文档元数据（类型、分块数）。若内容为空（chunkCount=0），说明文档尚未解析完成，需等待解析或触发重新解析。",
      inputSchema: {
        resourceId: z.string().min(1).describe("知识库资源的本地 ID，来自 kb_search 结果中的 resourceId。"),
      },
    },
    async ({ resourceId }) => {
      if (!environment.agentConfigId) {
        throw new Error("Environment agent is not configured");
      }
      const result = await readKnowledgeResourceForAgent({
        agentConfigId: environment.agentConfigId,
        resourceId,
        userId: environment.userId ?? undefined,
        organizationId: environment.organizationId ?? undefined,
      });
      // 内容为空时给出明确提示，帮助 agent 判断下一步操作
      if (!result.content && result.chunkCount === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...result,
                _hint: "该文档尚未解析（chunkCount=0）。请等待解析完成，或使用文档的 reparse 功能触发重新解析。",
              }),
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "kb_graph_get",
    {
      description:
        "获取 Agent 绑定知识库的知识图谱数据，包含实体节点（nodes）和关系边（edges）。若未指定 knowledgeBaseId，则返回第一个有图谱的绑定知识库的数据。节点含 id/name/entity_type/weight/description，边含 id/source/target/weight/description。",
      inputSchema: {
        knowledgeBaseId: z
          .string()
          .optional()
          .describe(
            "知识库 ID，不传则返回第一个有图谱的绑定知识库。可通过 kb_list_knowledge_bases 获取可用的知识库 ID。",
          ),
      },
    },
    async ({ knowledgeBaseId }) => {
      if (!environment.agentConfigId) {
        throw new Error("Environment agent is not configured");
      }
      const result = await getKnowledgeGraphForAgent({
        agentConfigId: environment.agentConfigId,
        knowledgeBaseId,
      });
      if (!result) {
        return {
          content: [{ type: "text", text: "未找到知识图谱数据。请先在知识库中生成知识图谱。" }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

const app = new Elysia({ name: "mcp-knowledge" }).decorate({ error: errorResponse }).model({
  "mcp-knowledge-auth-headers": McpKnowledgeAuthHeadersSchema,
});

app.all(
  "/mcp/knowledge",
  async ({ request, error }) => {
    const token = getBearerToken(request.headers.get("Authorization") ?? undefined);
    if (!token) {
      return error(401, { error: { message: "Missing bearer token" } });
    }

    const environment = await getEnvironmentBySecret(token);
    if (!environment) {
      return error(401, { error: { message: "Invalid bearer token" } });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    const server = createKnowledgeMcpServer(environment);
    await server.connect(transport);
    return transport.handleRequest(request);
  },
  {
    headers: "mcp-knowledge-auth-headers",
    detail: {
      hide: true,
      tags: ["Knowledge"],
      summary: "Agent 知识库 MCP 服务入口",
      description:
        "提供给底层 Agent 运行时调用的内部 MCP Streamable HTTP 服务入口。调用方需通过 `Authorization: Bearer <environment_secret>` 鉴权。" +
        "暴露 3 个 MCP tools：" +
        "`kb_search`（语义检索，支持相似度阈值/向量权重/Rerank/跨语言/知识图谱增强/元数据过滤）；" +
        "`kb_read`（读取绑定知识资源完整内容）；" +
        "`kb_graph_get`（获取知识图谱节点和边数据）。" +
        "该接口为 MCP 协议入口，不按普通 REST 响应建模，因此在公开文档中隐藏。",
    },
  },
);

export default app;
