/**
 * LaunchSpec 子域的公开类型。
 *
 * LaunchSpec 是启动一个 Agent 实例所需的全部静态信息的聚合视图：
 * 环境、扁平化 Agent 配置（skills/kb/mcp 已内嵌）、引擎信息、工作区路径与发起用户。
 * 由 {@link LaunchSpecBuilder} 从各 Repo 聚合构建，经 AgentNode 工厂下发给远端 Machine。
 */

import type { AgentConfigData, AgentEngineData } from "../types/deps";

/** 启动 Agent 实例的完整规格（构建完成后不可变）。 */
export interface LaunchSpec {
  /** 来源环境 ID。 */
  environmentId: string;
  /** 扁平聚合的 Agent 配置（I1 定义，skills/knowledgeBases/mcpServers 已内嵌）。 */
  agentConfig: AgentConfigData;
  /** 引擎信息（按 agentConfig.engineId 解析）。 */
  engine: AgentEngineData;
  /** 受控工作区路径：`{workspaceRoot}/{organizationId}/{userId}/{environmentId}`。 */
  cwd: string;
  /** 发起启动的用户 ID。 */
  userId: string;
}
