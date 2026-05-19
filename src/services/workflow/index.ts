/**
 * WorkflowEngine 服务单例。
 *
 * 每个 team 缓存一个引擎实例（Map），因为：
 * - StorageAdapter 按 teamId 隔离数据，不能跨 team 共享
 * - 引擎内部维护 activeRuns Map（取消/审批状态），不能每次请求重建
 * - Transport（ACP WebSocket）是全局共享的，所有引擎复用同一个实例
 */

import type { WorkflowEngine, AgentResolvedConfig } from "@mothership/workflow-engine";
import { createWorkflowEngine } from "@mothership/workflow-engine";
import type { Transport } from "@mothership/workflow-engine";
import { createAcpTransport } from "./acp-transport";
import { createPgStorageAdapter } from "./pg-storage-adapter";
import { db } from "../../db";
import { agentConfig } from "../../db/schema";
import { eq } from "drizzle-orm";

// 每个 team 一个引擎实例，lazy 创建
const engines = new Map<string, WorkflowEngine>();
let _transport: Transport | null = null;

/** 获取全局共享的 Transport 单例 */
function getTransport(): Transport {
  if (!_transport) _transport = createAcpTransport();
  return _transport;
}

/** 创建 resolveAgentConfig 回调：按 name 查询 agentConfig 表 */
function createAgentConfigResolver(teamId: string): (name: string) => Promise<AgentResolvedConfig | null> {
  return async (name: string) => {
    const rows = await db
      .select()
      .from(agentConfig)
      .where(eq(agentConfig.teamId, teamId))
      .limit(100);

    const row = rows.find((r) => r.name === name);
    if (!row) return null;

    return {
      model: row.model ?? null,
      steps: row.steps ?? null,
      temperature: row.temperature != null ? Number(row.temperature) : null,
      permission: row.permission ?? null,
      knowledge: row.knowledge ?? null,
    };
  };
}

/** 获取或创建指定 team 的 WorkflowEngine 实例 */
export function getTeamEngine(teamId: string): WorkflowEngine {
  let engine = engines.get(teamId);
  if (!engine) {
    const storage = createPgStorageAdapter(teamId);
    engine = createWorkflowEngine({
      storage,
      transport: getTransport(),
      hmacSecret: process.env.RCS_WORKFLOW_HMAC_SECRET || crypto.randomUUID(),
      resolveAgentConfig: createAgentConfigResolver(teamId),
    });
    engines.set(teamId, engine);
  }
  return engine;
}
