import { log } from "@fenix/logger";
import type { McpServerConfig } from "@fenix/plugin-sdk";
import type { McpServerRow } from "@fenix/resource-mcp/server";
import type { ScopedAgentConfigRow } from "../../repositories/agent-config-resource";
import { LAUNCH_SPEC_LOG_PREFIX, summarizeRawMcpServers, throwInvalidConfig } from "./support";
import type { AgentLaunchSpecAssemblerDeps } from "./types";

/**
 * MCP 解析：绑定集合 → 行（按绑定顺序）→ SDK 配置。
 *
 * AgentConfig 是「显式勾选」语义：空绑定就是不注入任何 MCP，**不回退**到组织下全部可用 MCP——
 * 回退会让"我没勾任何工具"变成"我拿到了组织里所有工具"，这在多租户下是权限扩张而不是便利。
 */

/**
 * 读取 Agent 显式绑定的 MCP 行，并保持与绑定顺序一致。
 *
 * 绑定指向缺失行、或指向已停用的行，一律阻断启动：两者都说明配置已经不一致，而继续启动的后果是
 * 工具集静默残缺——排查成本远高于让启动失败。
 */
export async function loadAgentMcpServers(
  deps: AgentLaunchSpecAssemblerDeps,
  agentConfig: ScopedAgentConfigRow,
): Promise<readonly McpServerRow[]> {
  const mcpIds = await deps.associations.listMcpIds(agentConfig.id);
  if (mcpIds.length === 0) return [];

  const mcpRows = await deps.mcp.listRowsByIdsUnscoped(mcpIds);
  const mcpById = new Map(mcpRows.map((row) => [row.id, row]));
  const missingMcpIds = mcpIds.filter((mcpId) => !mcpById.has(mcpId));
  if (missingMcpIds.length > 0) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' references missing MCP servers`,
      `${LAUNCH_SPEC_LOG_PREFIX} missing mcp rows for agentConfig='${agentConfig.id}', missingMcpIds=${JSON.stringify(missingMcpIds)}, available=${JSON.stringify(
        summarizeRawMcpServers(mcpRows),
      )}`,
    );
  }

  const disabledMcpRows = mcpRows.filter((row) => !row.enabled);
  if (disabledMcpRows.length > 0) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' references disabled MCP servers`,
      `${LAUNCH_SPEC_LOG_PREFIX} disabled mcp rows for agentConfig='${agentConfig.id}', disabled=${JSON.stringify(summarizeRawMcpServers(disabledMcpRows))}`,
    );
  }

  // 与 skill 同理：ID 全部命中，`get` 必然有值，用非空断言而不是再判一次。
  return mcpIds.map((mcpId) => mcpById.get(mcpId) as McpServerRow);
}

/**
 * 把数据库里的 MCP 配置翻译成 runtime 可消费的 SDK 配置。
 *
 * 非法结构不做 skip：skip 会让实例"看起来能启动"，但工具集已经残缺；直接失败能把问题钉在配置上。
 * `local` 与 `stdio` 是两代写法（前者 `command` 是数组），这里都接受并归一到 SDK 的 `stdio` 形状。
 */
export function toSdkMcpConfig(name: string, raw: Record<string, unknown>, agentConfigId: string): McpServerConfig {
  if (raw.type === "local") {
    if (!Array.isArray(raw.command) || raw.command.length === 0 || typeof raw.command[0] !== "string") {
      throwInvalidConfig(
        `AgentConfig '${agentConfigId}' has invalid MCP config '${name}'`,
        `${LAUNCH_SPEC_LOG_PREFIX} invalid local MCP command for agentConfig='${agentConfigId}', mcp='${name}', raw=${JSON.stringify(raw)}`,
      );
    }
    const cmd = raw.command.filter((value): value is string => typeof value === "string");
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
    if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
      throwInvalidConfig(
        `AgentConfig '${agentConfigId}' has invalid MCP config '${name}'`,
        `${LAUNCH_SPEC_LOG_PREFIX} invalid remote MCP url for agentConfig='${agentConfigId}', mcp='${name}', raw=${JSON.stringify(raw)}`,
      );
    }
    return {
      name,
      type: "streamable-http",
      url: raw.url,
      headers: raw.headers as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  if (raw.type === "stdio") {
    if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
      throwInvalidConfig(
        `AgentConfig '${agentConfigId}' has invalid MCP config '${name}'`,
        `${LAUNCH_SPEC_LOG_PREFIX} invalid stdio MCP command for agentConfig='${agentConfigId}', mcp='${name}', raw=${JSON.stringify(raw)}`,
      );
    }
    return {
      name,
      type: "stdio",
      command: raw.command,
      args: Array.isArray(raw.args)
        ? raw.args.filter((value): value is string => typeof value === "string")
        : undefined,
      env: raw.env as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  throwInvalidConfig(
    `AgentConfig '${agentConfigId}' has unsupported MCP config '${name}'`,
    `${LAUNCH_SPEC_LOG_PREFIX} unsupported MCP config type for agentConfig='${agentConfigId}', mcp='${name}', raw=${JSON.stringify(raw)}`,
  );
}

/**
 * 把绑定顺序上的 MCP 行逐条翻译成 SDK 配置（翻译规则见 {@link toSdkMcpConfig}）。
 *
 * `config` 列历史上写过字符串形式的 JSON，两种形状都要接受；解析失败按配置损坏处理。解析失败的日志
 * 只记录**长度与类型**而不是原文——MCP 配置里常有 `headers` / `env` 形式的凭证，原文进日志等于把
 * 密钥落盘（迁移前的实现会打印整段 config，这里不再沿用）。
 */
export function buildMcpSpecs(mcpServers: readonly McpServerRow[], agentConfigId: string): McpServerConfig[] {
  return mcpServers.map((row) => {
    let raw: Record<string, unknown>;
    try {
      raw = typeof row.config === "string" ? JSON.parse(row.config) : ((row.config ?? {}) as Record<string, unknown>);
    } catch (error) {
      throwInvalidConfig(
        `AgentConfig '${agentConfigId}' has invalid MCP config '${row.name}'`,
        `${LAUNCH_SPEC_LOG_PREFIX} invalid MCP JSON for agentConfig='${agentConfigId}', mcp='${row.name}', configType='${typeof row.config}', configLength=${String(row.config).length}`,
        error,
      );
    }
    log(
      `${LAUNCH_SPEC_LOG_PREFIX} buildAgentLaunchSpec: translating mcp '${row.name}' rawType='${String(raw.type ?? row.type ?? "unknown")}'`,
    );
    return toSdkMcpConfig(row.name, raw, agentConfigId);
  });
}
