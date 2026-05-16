import type { AgentLaunchSpec, McpServerConfig, ModelConfig } from "@mothership/plugin-sdk";
import type { AgentFullConfig } from "./config-pg";
import { getBaseUrl } from "../config";
import { listAgentKnowledgeBindings } from "./agent-knowledge";
import { log } from "../logger";

function inferProtocol(npm?: string | null): "openai" | "anthropic" {
  if (npm?.includes("anthropic")) return "anthropic";
  return "openai";
}

/**
 * 将 DB 中的 MCP server JSONB 配置转换为 SDK McpServerConfig 格式。
 *
 * DB 格式 (opencode 格式):
 *   { type: "local", command: ["npx", "-y", "..."], environment: {...} }
 *   { type: "remote", url: "...", headers: {...} }
 *
 * SDK 格式:
 *   { type: "stdio", command: "npx", args: ["-y", "..."], env: {...} }
 *   { type: "streamable-http", url: "...", headers: {...} }
 */
function toSdkMcpConfig(name: string, raw: Record<string, unknown>): McpServerConfig | null {
  if (raw.type === "local" && Array.isArray(raw.command)) {
    const cmd = raw.command as string[];
    return {
      name,
      type: "stdio",
      command: cmd[0] ?? "",
      args: cmd.length > 1 ? cmd.slice(1) : undefined,
      env: raw.environment as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  if (raw.type === "remote" || raw.type === "streamable-http") {
    return {
      name,
      type: "streamable-http",
      url: raw.url as string,
      headers: raw.headers as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  if (raw.type === "stdio") {
    return {
      name,
      type: "stdio",
      command: raw.command as string,
      args: raw.args as string[] | undefined,
      env: raw.env as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  log(`[launch-spec-builder] 跳过无法识别的 MCP 配置: ${name} (type=${raw.type})`);
  return null;
}

function resolveModelConfig(
  modelRef: string | null | undefined,
  providers: AgentFullConfig["providers"],
): ModelConfig {
  const fallback: ModelConfig = {
    provider: "openai",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o",
  };

  if (!modelRef) return fallback;

  const slashIndex = modelRef.indexOf("/");
  if (slashIndex < 0) {
    return { ...fallback, model: modelRef };
  }

  const providerName = modelRef.slice(0, slashIndex);
  const modelId = modelRef.slice(slashIndex + 1);

  const prov = providers.find((p) => p.name === providerName);
  if (!prov) {
    log(`[launch-spec-builder] 未找到 provider '${providerName}'，使用默认配置`);
    return { ...fallback, model: modelRef };
  }

  return {
    provider: providerName,
    protocol: inferProtocol(prov.npm),
    baseUrl: prov.baseUrl || "",
    apiKey: prov.apiKey || "",
    model: modelId,
  };
}

export interface BuildLaunchSpecInput {
  workspacePath: string;
  agentName: string;
  agentPrompt?: string | null;
  modelRef?: string | null;
  fullConfig: AgentFullConfig;
  environmentSecret: string;
}

export async function buildLaunchSpec(input: BuildLaunchSpecInput): Promise<AgentLaunchSpec> {
  const { workspacePath, agentName, agentPrompt, modelRef, fullConfig, environmentSecret } = input;

  const agent = {
    name: agentName,
    ...(agentPrompt ? { prompt: agentPrompt } : {}),
  };

  const model = resolveModelConfig(modelRef, fullConfig.providers);

  const mcpServers: McpServerConfig[] = [];
  for (const server of fullConfig.mcpServers) {
    const raw = typeof server.config === "string"
      ? JSON.parse(server.config)
      : server.config;
    const sdkConfig = toSdkMcpConfig(server.name, raw as Record<string, unknown>);
    if (sdkConfig) {
      mcpServers.push(sdkConfig);
    }
  }

  const knowledgeBindings = await listAgentKnowledgeBindings(agentName);
  if (knowledgeBindings.length > 0) {
    mcpServers.push({
      name: "kb",
      type: "streamable-http",
      url: `${getBaseUrl()}/mcp/knowledge`,
      headers: { Authorization: `Bearer ${environmentSecret}` },
      timeout: 15000,
    });
  }

  return {
    workspace: workspacePath,
    agent,
    model,
    skills: [],
    mcpServers,
  };
}
