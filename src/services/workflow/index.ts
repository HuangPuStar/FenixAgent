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
import { stopInstance } from "../instance";
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

/**
 * workflow 结束后停止本次 run 实际创建（spawned）的实例。
 *
 * 入参是 Transport 层记录的 instanceId 集合（agent-chat-transport 在 ensureRunning
 * 返回 status === "spawned" 时写入），而非 envId——按 envId 查询会误杀同环境内
 * 其他 run / 用户交互启动的实例（C-P1.1）。复用的实例不归本 run 所有，交给创建者
 * 清理或 acp-idle-monitor 空闲回收。
 */
export async function cleanupSpawnedInstances(instanceIds: Set<string>, organizationId: string): Promise<void> {
  for (const instanceId of instanceIds) {
    try {
      await stopInstance(instanceId, organizationId);
    } catch (err) {
      // 单个实例停止失败不中断其余清理；stopInstance 对不存在/跨 org 实例返回
      // ok:false 不抛错，此处仅兜底意外异常
      logger.error(`Failed to stop spawned instance: instanceId=${instanceId}`, err);
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
