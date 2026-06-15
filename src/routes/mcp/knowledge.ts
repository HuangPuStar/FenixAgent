import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import Elysia from "elysia";
import * as z from "zod/v4";
import { errorResponse } from "../../plugins/auth";
import { McpKnowledgeAuthHeadersSchema } from "../../schemas";
import { getEnvironmentBySecret } from "../../services/environment";
import { readKnowledgeResourceForAgent, searchKnowledgeByConfigId } from "../../services/knowledge-runtime";

function getBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function createKnowledgeMcpServer(environment: {
  agentConfigId: string | null;
  userId: string | null;
  secret: string;
}) {
  const server = new McpServer({
    name: "kb-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "kb_search",
    {
      description: "Searches the agent's bound knowledge bases.",
      inputSchema: {
        query: z.string().min(1),
        topK: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ query, topK }) => {
      if (!environment.agentConfigId) {
        throw new Error("Environment agent is not configured");
      }
      const results = await searchKnowledgeByConfigId({
        agentConfigId: environment.agentConfigId,
        query,
        topK: topK ?? 5,
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
      description: "Reads a knowledge resource already bound to the agent.",
      inputSchema: {
        resourceId: z.string().min(1),
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
      });
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
        "提供给底层 Agent 运行时调用的内部 MCP Streamable HTTP 服务入口。调用方需通过 `Authorization: Bearer <environment_secret>` 鉴权。当前暴露两个 MCP tools：`kb_search`（输入 `{ query, topK? }`，在 Agent 绑定知识库中检索）和 `kb_read`（输入 `{ resourceId }`，读取已绑定知识资源内容）。该接口为 MCP 协议入口，不按普通 REST 响应建模，因此在公开文档中隐藏。",
    },
  },
);

export default app;
