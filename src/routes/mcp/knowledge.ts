import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";
import { storeGetEnvironmentBySecret } from "../../store";
import {
  readKnowledgeResourceForAgent,
  searchKnowledgeForAgent,
} from "../../services/knowledge-runtime";

function getBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function createKnowledgeMcpServer(environment: { agentName: string | null; userId: string | null; secret: string }) {
  const server = new McpServer({
    name: "kb-mcp",
    version: "1.0.0",
  });

  server.registerTool("kb_search", {
    description: "Searches the agent's bound knowledge bases.",
    inputSchema: {
      query: z.string().min(1),
      topK: z.number().int().min(1).max(20).optional(),
      agentName: z.string().min(1).optional(),
    },
  }, async ({ query, topK, agentName }) => {
    if (!environment.agentName) {
      throw new Error("Environment default agent is not configured");
    }
    if (agentName && agentName !== environment.agentName) {
      throw new Error("agentName does not match environment default agent");
    }
    const results = await searchKnowledgeForAgent({
      agentName: environment.agentName,
      query,
      topK: topK ?? 5,
      userId: environment.userId ?? undefined,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ results }) }],
      structuredContent: { results },
    };
  });

  server.registerTool("kb_read", {
    description: "Reads a knowledge resource already bound to the agent.",
    inputSchema: {
      resourceId: z.string().min(1),
    },
  }, async ({ resourceId }) => {
    if (!environment.agentName) {
      throw new Error("Environment default agent is not configured");
    }
    const result = await readKnowledgeResourceForAgent({
      agentName: environment.agentName,
      resourceId,
      userId: environment.userId ?? undefined,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  });

  return server;
}

const app = new Hono();

app.all("/mcp/knowledge", async (c) => {
  const token = getBearerToken(c.req.header("Authorization"));
  if (!token) {
    return c.json({ error: { message: "Missing bearer token" } }, 401);
  }

  const environment = storeGetEnvironmentBySecret(token);
  if (!environment) {
    return c.json({ error: { message: "Invalid bearer token" } }, 401);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });
  const server = createKnowledgeMcpServer(environment);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export default app;
