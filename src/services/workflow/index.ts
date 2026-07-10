/**
 * WorkflowEngine 服务单例。
 *
 * 每个 team 缓存一个 (engine + transport) 二元组，因为：
 * - StorageAdapter 按 organizationId 隔离数据，不能跨 organization 共享
 * - Transport 绑定 organizationId（否则跨组织泄露）
 * - 引擎内部维护 activeRuns Map（取消/审批状态），不能每次请求重建
 *
 * 服务层职责：
 * - 环境解析 → 实例启动 → relay 连接统一由 agent-chat-transport 处理（复用 agent-chat-service）
 * - workflow 结束后统一销毁启动的实例
 */

import { createLogger } from "@fenix/logger";
import type { Transport, WorkflowEngine } from "@fenix/workflow-engine";
import { createWorkflowEngine } from "@fenix/workflow-engine";
import { getRunningInstancesByEnvironment, stopInstance } from "../instance";
import { createAgentChatTransport } from "./agent-chat-transport";
import { getCustomToolsRegistry } from "./custom-tools";
import { createPgStorageAdapter } from "./pg-storage-adapter";

const logger = createLogger("wf-service");

interface TeamRuntime {
  engine: WorkflowEngine;
  transport: Transport;
}

// 每个 team 一个 (engine, transport) 对，lazy 创建、互相隔离
const teamRuntimes = new Map<string, TeamRuntime>();

/** workflow 结束后销毁期间启动的实例 */
export async function cleanupSpawnedEnvironments(envIds: Set<string>, organizationId: string): Promise<void> {
  for (const envId of envIds) {
    try {
      const instances = getRunningInstancesByEnvironment(envId);
      for (const inst of instances) {
        await stopInstance(inst.id, organizationId);
      }
    } catch (err) {
      logger.error(`Failed to stop environment: envId=${envId}`, err);
    }
  }
}

/**
 * 获取或创建指定 team 的 WorkflowEngine 实例。
 * Transport 按 organizationId 隔离，绝不跨组织复用。
 * Agent 通信复用 agent-chat-service（createAgentSession + startPromptTurn），
 * 不再有独立的 ACP 协议栈。
 */
export function getTeamEngine(organizationId: string): WorkflowEngine {
  let runtime = teamRuntimes.get(organizationId);
  if (!runtime) {
    const transport = createAgentChatTransport(organizationId);
    const storage = createPgStorageAdapter(organizationId);
    const engine = createWorkflowEngine({
      storage,
      transport,
      hmacSecret: process.env.RCS_WORKFLOW_HMAC_SECRET || crypto.randomUUID(),
      customRegistry: getCustomToolsRegistry(),
    });
    runtime = { engine, transport };
    teamRuntimes.set(organizationId, runtime);
  }
  return runtime.engine;
}

/** 移除指定 team 的 WorkflowEngine 实例（释放内存） */
export function removeTeamEngine(organizationId: string): boolean {
  return teamRuntimes.delete(organizationId);
}

/** 清理所有缓存的 engine 实例 */
export function clearAllEngines(): void {
  teamRuntimes.clear();
}
