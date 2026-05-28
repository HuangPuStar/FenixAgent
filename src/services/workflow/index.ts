/**
 * WorkflowEngine 服务单例。
 *
 * 每个 team 缓存一个引擎实例（Map），因为：
 * - StorageAdapter 按 organizationId 隔离数据，不能跨 organization 共享
 * - 引擎内部维护 activeRuns Map（取消/审批状态），不能每次请求重建
 * - Transport（ACP WebSocket）是全局共享的，所有引擎复用同一个实例
 */

import type { AgentResolvedConfig, Transport, WorkflowEngine } from "@fenix/workflow-engine";
import { createWorkflowEngine } from "@fenix/workflow-engine";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { agentConfig, agentConfigSkill, environment, skill } from "../../db/schema";
import { createAcpTransport, setAgentNameResolver } from "./acp-transport";
import { createPgStorageAdapter } from "./pg-storage-adapter";

// 每个 team 一个引擎实例，lazy 创建
const engines = new Map<string, WorkflowEngine>();
let _transport: Transport | null = null;

/** 获取全局共享的 Transport 单例 */
function getTransport(organizationId: string): Transport {
  if (!_transport) {
    _transport = createAcpTransport();
    // 注入 agentConfig name → Environment ID 解析器
    setAgentNameResolver(createAgentNameResolverFn(organizationId));
  }
  return _transport;
}

/**
 * 创建 agentConfig name → 在线 Environment ID 的解析器。
 *
 * 数据流：agentConfig.name → agentConfig.id → environment.agentConfigId → ACP 连接
 */
function createAgentNameResolverFn(organizationId: string): (name: string) => Promise<string | null> {
  return async (name: string) => {
    // 1. 按 name 查 agentConfig，获取 id
    const [configRow] = await db
      .select({ id: agentConfig.id })
      .from(agentConfig)
      .where(and(eq(agentConfig.organizationId, organizationId), eq(agentConfig.name, name)))
      .limit(1);

    if (!configRow) return null;

    // 2. 按 agentConfigId 查 Environment，取第一个
    const [envRow] = await db
      .select({ id: environment.id })
      .from(environment)
      .where(and(eq(environment.agentConfigId, configRow.id), eq(environment.organizationId, organizationId)))
      .limit(1);

    return envRow?.id ?? null;
  };
}

/** 创建 resolveAgentConfig 回调：按 name 查询 agentConfig 表 + skill 绑定 */
function createAgentConfigResolver(organizationId: string): (name: string) => Promise<AgentResolvedConfig | null> {
  return async (name: string) => {
    const [row] = await db
      .select()
      .from(agentConfig)
      .where(and(eq(agentConfig.organizationId, organizationId), eq(agentConfig.name, name)))
      .limit(1);

    if (!row) return null;

    // 查询关联的 skill 绑定
    const skillRows = await db
      .select({ name: skill.name })
      .from(agentConfigSkill)
      .innerJoin(skill, eq(agentConfigSkill.skillId, skill.id))
      .where(eq(agentConfigSkill.agentConfigId, row.id));

    return {
      model: row.model ?? null,
      steps: row.steps ?? null,
      temperature: row.temperature != null ? Number(row.temperature) : null,
      permission: row.permission ?? null,
      knowledge: row.knowledge ?? null,
      prompt: row.prompt ?? null,
      skills: skillRows.map((s) => s.name),
    };
  };
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
      resolveAgentConfig: createAgentConfigResolver(organizationId),
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
