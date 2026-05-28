/**
 * WorkflowEngine 服务单例。
 *
 * 每个 team 缓存一个引擎实例（Map），因为：
 * - StorageAdapter 按 organizationId 隔离数据，不能跨 organization 共享
 * - 引擎内部维护 activeRuns Map（取消/审批状态），不能每次请求重建
 * - Transport（ACP WebSocket）是全局共享的，所有引擎复用同一个实例
 */

import type { Transport, WorkflowEngine } from "@fenix/workflow-engine";
import { createWorkflowEngine } from "@fenix/workflow-engine";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { environment } from "../../db/schema";
import { ensureRunning, getRunningInstancesByEnvironment, stopInstance } from "../instance";
import { createAcpTransport, type EnvironmentResolver, setEnvironmentResolver } from "./acp-transport";
import { createPgStorageAdapter } from "./pg-storage-adapter";

// 每个 team 一个引擎实例，lazy 创建
const engines = new Map<string, WorkflowEngine>();
let _transport: Transport | null = null;

/** 获取全局共享的 Transport 单例，注入 EnvironmentResolver */
function getTransport(organizationId: string): Transport {
  if (!_transport) {
    _transport = createAcpTransport();
    setEnvironmentResolver(createEnvironmentResolver(organizationId));
  }
  return _transport;
}

/**
 * 创建 Environment name → envId 的解析器。
 *
 * 数据流：Environment.name → 查 Environment 表获取 id → 检查 ACP 连接 → ensureRunning 启动实例
 */
function createEnvironmentResolver(organizationId: string): EnvironmentResolver {
  return {
    async resolve(name: string) {
      // 1. 按 name 查 Environment
      const [envRow] = await db
        .select({ id: environment.id })
        .from(environment)
        .where(and(eq(environment.name, name), eq(environment.organizationId, organizationId)))
        .limit(1);

      if (!envRow) throw new Error(`Environment '${name}' not found`);

      // 2. 检查是否已有在线 ACP 连接
      const { findAcpConnectionByAgentId } = await import("../../transport/acp-ws-handler");
      const conn = findAcpConnectionByAgentId(envRow.id);
      if (conn) return { envId: envRow.id, started: false };

      // 3. 调用 ensureRunning 启动实例（使用系统用户 ID，workflow 执行不关联特定用户）
      await ensureRunning("system", envRow.id);
      return { envId: envRow.id, started: true };
    },
  };
}

/** workflow 结束后销毁期间启动的实例 */
export async function cleanupSpawnedEnvironments(envIds: Set<string>, organizationId: string): Promise<void> {
  for (const envId of envIds) {
    try {
      const instances = getRunningInstancesByEnvironment(envId);
      for (const inst of instances) {
        await stopInstance(inst.id, organizationId);
      }
    } catch (err) {
      console.error(`[Workflow] Failed to stop environment ${envId}:`, err);
    }
  }
}

/** 获取或创建指定 team 的 WorkflowEngine 实例 */
export function getTeamEngine(organizationId: string): WorkflowEngine {
  let engine = engines.get(organizationId);
  if (!engine) {
    const storage = createPgStorageAdapter(organizationId);
    engine = createWorkflowEngine({
      storage,
      transport: getTransport(organizationId),
      hmacSecret: process.env.RCS_WORKFLOW_HMAC_SECRET || crypto.randomUUID(),
    });
    engines.set(organizationId, engine);
  }
  return engine;
}

/** 移除指定 team 的 WorkflowEngine 实例（释放内存） */
export function removeTeamEngine(organizationId: string): boolean {
  return engines.delete(organizationId);
}

/** 清理所有缓存的 engine 实例 */
export function clearAllEngines(): void {
  engines.clear();
}
