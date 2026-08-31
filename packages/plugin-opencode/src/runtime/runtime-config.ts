import type { AgentLaunchSpec, McpServerConfig } from "@fenix/plugin-sdk";

export interface InstalledSkillReference {
  name: string;
  path: string;
}

export interface OpencodeProviderModelConfig {
  name: string;
  modalities?: {
    input?: ("text" | "image")[];
    output?: ("text" | "image")[];
  };
  /**
   * 模型限制配置；OpenCode schema 要求 context 和 output 同时提供。
   * 仅当 context > output 时下发：OpenCode 按 usable = context - min(output, 32000) 计算可用上下文，
   * context <= output 会令 usable ≤ 0 从而卡死 agent。
   */
  limit?: {
    context: number;
    output: number;
  };
}

export interface OpencodeProviderConfig {
  npm: string;
  options: {
    baseURL: string;
    apiKey: string;
    setCacheKey: boolean;
  };
  models: Record<string, OpencodeProviderModelConfig>;
}

export interface OpencodeAgentConfig {
  model: string;
  mode: "primary";
  steps: number;
  prompt?: string;
  hidden: boolean;
  disable: boolean;
}

export interface OpencodeStdioMcpConfig {
  type: "local";
  command: string[];
  cwd?: string;
  environment?: Record<string, string>;
  timeout?: number;
}

export interface OpencodeRemoteMcpConfig {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpServerConfig extends infer _Unused ? never : never;
  timeout?: number;
}

export type OpencodeMcpConfig = OpencodeStdioMcpConfig | OpencodeRemoteMcpConfig;

export interface OpencodeRuntimeConfig {
  $schema: string;
  autoupdate: boolean;
  default_agent: string;
  enabled_providers: string[];
  provider: Record<string, OpencodeProviderConfig>;
  model: string;
  agent: Record<string, OpencodeAgentConfig>;
  mcp: Record<string, OpencodeMcpConfig>;
  plugin?: Array<[string, Record<string, unknown>]>;
}

function toProviderPackage(protocol: AgentLaunchSpec["model"]["protocol"]): string {
  switch (protocol) {
    case "anthropic":
      return "@ai-sdk/anthropic";
    default:
      return "@ai-sdk/openai-compatible";
  }
}

function toMcpRecord(mcpServers: AgentLaunchSpec["mcpServers"]): Record<string, OpencodeMcpConfig> {
  return Object.fromEntries(
    mcpServers.map((server) => {
      if (server.type === "stdio") {
        return [
          server.name,
          {
            type: "local",
            command: [server.command, ...(server.args ?? [])],
            cwd: server.cwd,
            environment: server.env,
            timeout: server.timeout,
          } satisfies OpencodeStdioMcpConfig,
        ];
      }

      return [
        server.name,
        {
          type: "remote",
          url: server.url,
          headers: server.headers,
          timeout: server.timeout,
        } satisfies OpencodeRemoteMcpConfig,
      ];
    }),
  );
}

/**
 * 把平台侧 `AgentLaunchSpec` 转成 opencode 运行时配置。
 */
export function buildOpencodeRuntimeConfig(
  launchSpec: AgentLaunchSpec,
  _installedSkills: InstalledSkillReference[],
): OpencodeRuntimeConfig {
  const providerId = launchSpec.model.provider;
  const modelId = launchSpec.model.modelName ?? launchSpec.model.model;
  const agentName = launchSpec.agent.name;
  const providerModelRef = `${providerId}/${modelId}`;

  return {
    $schema: "https://opencode.ai/config.json",
    // 禁止 opencode 自动更新，避免新版本在未验证前引入兼容性问题。
    autoupdate: false,
    default_agent: agentName,
    enabled_providers: [providerId],
    provider: {
      [providerId]: {
        npm: toProviderPackage(launchSpec.model.protocol),
        options: {
          baseURL: launchSpec.model.baseUrl,
          apiKey: launchSpec.model.apiKey,
          setCacheKey: true,
        },
        models: {
          [modelId]: (() => {
            const modelEntry: OpencodeProviderModelConfig = {
              name: launchSpec.model.model,
            };
            const rawModalities = launchSpec.model.modalities;
            // 仅当 modalities 是对象格式（非数组）且 input 包含 "image" 时才认为支持图片
            const modelHasImage =
              rawModalities != null &&
              typeof rawModalities === "object" &&
              !Array.isArray(rawModalities) &&
              (rawModalities as { input?: string[] }).input?.includes("image");

            if (modelHasImage) {
              modelEntry.modalities = rawModalities as { input?: ("text" | "image")[]; output?: ("text" | "image")[] };
            } else {
              modelEntry.modalities = { input: ["text"], output: ["text"] };
            }

            // 限制配置：context/output 必须同时 > 0，且 context > output。
            // OpenCode 用 usable = context - min(output, 32000) 计算可用上下文（overflow.ts），
            // 当 context <= output 时 usable ≤ 0，每条消息立即触发 compaction 导致 agent 卡死/无输出。
            // 因此 context 不大于 output 时跳过 limit，回退到引擎默认值。
            const limitConfig = launchSpec.model.limitConfig;
            if (
              limitConfig?.context &&
              limitConfig.context > 0 &&
              limitConfig?.output &&
              limitConfig.output > 0 &&
              limitConfig.context > limitConfig.output
            ) {
              modelEntry.limit = { context: limitConfig.context, output: limitConfig.output };
            }

            return modelEntry;
          })(),
        },
      },
    },
    model: providerModelRef,
    agent: {
      [agentName]: {
        model: providerModelRef,
        mode: "primary",
        steps: (launchSpec.agent.extra?.steps as number) ?? 1000,
        ...(launchSpec.agent.prompt ? { prompt: launchSpec.agent.prompt } : {}),
        hidden: false,
        disable: false,
      },
    },
    mcp: toMcpRecord(launchSpec.mcpServers.filter((s) => s.name !== "hindsight")),
    ...(launchSpec.agent.extra?.plugin && Array.isArray(launchSpec.agent.extra.plugin)
      ? { plugin: launchSpec.agent.extra.plugin as Array<[string, Record<string, unknown>]> }
      : {}),
  };
}
