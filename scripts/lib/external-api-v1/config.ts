import assert from "node:assert/strict";
import type { ConnectionConfig } from "./runner";

/** Agent 资源、实例、上传和多轮对话测试配置。 */
export interface AgentTestConfig extends ConnectionConfig {
  provider: { protocol: "openai" | "anthropic"; baseUrl: string; apiKey: string };
  upstreamModel: string;
  runtimeModelId: string;
  knowledgeBaseId: string;
  mcpConfig: Record<string, unknown>;
  agentNode: Record<string, unknown>;
  acpPermission: "deny" | "allow_once";
}

/** 已发布旧版工作流的同步执行配置。 */
export interface WorkflowTestConfig extends ConnectionConfig {
  workflowId: string;
  inputs: Record<string, unknown>;
}

/** 已发布 Workflow v2 的同步执行配置；workflowId 使用平台 UUID。 */
export interface WorkflowV2TestConfig extends ConnectionConfig {
  workflowId: string;
  parameters: string | Record<string, unknown>;
}

/** 各测试只校验自身连接信息，不依赖其他类别的配置。 */
export function validateConnectionConfig(config: ConnectionConfig, name: string): void {
  assert.ok(config.apiKey && !config.apiKey.includes("EDIT_"), `请填写 ${name}.apiKey`);
  assert.ok(Number.isFinite(config.timeoutMs) && config.timeoutMs > 0, `${name}.timeoutMs 必须大于 0`);
  assert.ok(["http:", "https:"].includes(new URL(config.baseUrl).protocol), `${name}.baseUrl 需要 HTTP(S) 地址`);
}
