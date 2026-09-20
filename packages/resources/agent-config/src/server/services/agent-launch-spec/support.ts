import { error as logError } from "@fenix/logger";
import { AppError } from "@fenix/platform-sdk";
import type { McpServerConfig, ModelConfig } from "@fenix/plugin-sdk";
import type { McpServerRow } from "@fenix/resource-mcp/server";
import type { SkillRow } from "@fenix/resource-skill/server";

/**
 * 启动参数组装的公共零件：日志前缀、失败语义、行与 SDK 结构的摘要。
 *
 * 日志前缀独立成一个常量：本模块的日志按前缀过滤，从 `agent-runtime` 搬来后前缀随之改名，
 * 但**不改变日志内容的结构**（排查时按字段名搜索仍命中）。
 */
export const LAUNCH_SPEC_LOG_PREFIX = "[agent-launch-spec]";

/** 模型协议：plugin-sdk 只声明 openai / anthropic 两种，其余一律阻断启动。 */
export type LaunchModelProtocol = ModelConfig["protocol"];

/**
 * 统一记录上下文日志并抛配置错误。
 *
 * 为什么是 `400 / INVALID_CONFIG` 而不是 500：这些都是**启动前的配置问题**（引用了不存在的模型、
 * Skill 源目录缺失、MCP 配置非法），前端要把它们当作"请去改配置"而不是"服务故障"。因此错误必须
 * 在启动前抛出，而不是让实例带着残缺的工具集"看起来启动成功"。
 */
export function throwInvalidConfig(message: string, detail: string, error?: unknown): never {
  if (error) {
    logError(detail, error);
  } else {
    logError(detail);
  }
  throw new AppError(message, "INVALID_CONFIG", 400);
}

/**
 * 运行时只支持 plugin-sdk 明确声明的协议，未知协议直接阻断启动以暴露配置问题。
 *
 * `agentConfigId` 只用于日志与错误文案的定位：`protocol` 来自 Provider 行，而 Provider 行可能在
 * 多个 Agent 之间共享，缺了 Agent 标识就定位不到是哪次启动引用了它。
 */
export function toLaunchModelProtocol(
  protocol: string | null | undefined,
  providerName: string,
  agentConfigId: string,
): LaunchModelProtocol {
  if (protocol === "openai" || protocol === "anthropic") return protocol;
  throwInvalidConfig(
    `AgentConfig '${agentConfigId}' references provider '${providerName}' with unsupported protocol`,
    `${LAUNCH_SPEC_LOG_PREFIX} unsupported provider protocol for agentConfig='${agentConfigId}', provider='${providerName}', protocol='${protocol ?? ""}'`,
  );
}

/** Skill 行的最小摘要：日志里只出现定位信息，不含源目录内容。 */
export function summarizeSkills(skills: readonly SkillRow[]) {
  return skills.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
  }));
}

/** MCP 行的最小摘要；`configType` 取配置内的 `type`，用来区分"配置形状不对"与"行本身不对"。 */
export function summarizeRawMcpServers(mcpServers: readonly McpServerRow[]) {
  return mcpServers.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    enabled: row.enabled,
    type: row.type,
    configType:
      row.config && typeof row.config === "object" ? ((row.config as Record<string, unknown>).type ?? null) : null,
  }));
}

/** 翻译后的 SDK 配置摘要：`command` / `url` 只取形状，headers 与 env 里的密钥不落日志。 */
export function summarizeLaunchMcpServers(mcpServers: readonly McpServerConfig[]) {
  return mcpServers.map((row) => ({
    name: row.name,
    type: row.type,
    command: row.type === "stdio" ? row.command : undefined,
    url: row.type === "streamable-http" ? row.url : undefined,
    timeout: row.timeout,
  }));
}
