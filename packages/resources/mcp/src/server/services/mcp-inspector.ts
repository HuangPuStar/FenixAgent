import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpToolItem {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpInspectResult {
  reachable: boolean;
  protocol: boolean;
  serverName?: string;
  serverVersion?: string;
  tools: McpToolItem[];
  transport?: "streamable-http" | "sse";
  message?: string;
}

/**
 * 使用 MCP SDK 连接远程服务器并获取 tools 列表
 * 先尝试 Streamable HTTP，失败时 fallback 到 SSE
 */
export async function inspectRemoteMcpServer(
  url: string,
  headers?: Record<string, string>,
  timeout?: number,
): Promise<McpInspectResult> {
  const ms = timeout ?? 10000;
  const client = new Client({ name: "rcs-inspector", version: "0.1.0" }, { capabilities: {} });

  // 尝试 Streamable HTTP
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: headers ?? {} },
    });
    await connectWithTimeout(client, transport, ms);
    const result = await collectInspectResult(client, "streamable-http");
    await safeClose(client, transport);
    return result;
  } catch {
    // Streamable HTTP 失败，尝试 SSE fallback
  }

  // 尝试 SSE
  try {
    const sseTransport = new SSEClientTransport(new URL(url), {
      requestInit: { headers: headers ?? {} },
    });
    await connectWithTimeout(client, sseTransport, ms);
    const result = await collectInspectResult(client, "sse");
    await safeClose(client, sseTransport);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "连接失败";
    return { reachable: false, protocol: false, tools: [], message: msg };
  }
}

async function connectWithTimeout(
  client: Client,
  transport: StreamableHTTPClientTransport | SSEClientTransport,
  ms: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    await client.connect(transport, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function collectInspectResult(client: Client, transport: "streamable-http" | "sse"): Promise<McpInspectResult> {
  const serverVersion = client.getServerVersion();
  const toolsResult = await client.listTools();
  const tools: McpToolItem[] = toolsResult.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown> | undefined,
  }));

  return {
    reachable: true,
    protocol: true,
    serverName: serverVersion?.name,
    serverVersion: serverVersion?.version,
    tools,
    transport,
  };
}

async function safeClose(client: Client, transport: StreamableHTTPClientTransport | SSEClientTransport) {
  try {
    await client.close();
  } catch {
    // ignore close errors
  }
  try {
    await transport.close();
  } catch {
    // ignore close errors
  }
}
