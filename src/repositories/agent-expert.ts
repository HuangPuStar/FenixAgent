/**
 * agent-expert.ts — 专家库（agent_expert / agent_config_expert）数据访问层。
 *
 * 领域规则（可见性校验、system 行写保护、软删除语义）由 services/config/agent-expert.ts
 * 承载，本文件只负责持久化与查询条件封装。
 *
 * 多租户约束：
 * - 内置专家 organizationId="system"（保留字），列表查询恒为 IN ('system', ?orgId)；
 * - 写操作只允许本组织行，system 行由上层拒绝；
 * - 引用同步（syncAgentExperts）必须事务包裹，避免并发覆盖丢失更新。
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { agentConfigExpert, agentExpert } from "../db/schema";

export type AgentExpertRow = typeof agentExpert.$inferSelect;
export type AgentExpertInsert = typeof agentExpert.$inferInsert;

/** 专家可见组织集合：内置（system）+ 指定组织 */
export function visibleOrgCondition(organizationId: string) {
  return inArray(agentExpert.organizationId, ["system", organizationId]);
}

/** 列出指定组织可见的专家（内置 + 本组织），内置优先、名称排序 */
export async function listVisibleExperts(
  organizationId: string,
  options: { includeDisabled?: boolean } = {},
): Promise<AgentExpertRow[]> {
  const conditions = [visibleOrgCondition(organizationId)];
  if (!options.includeDisabled) {
    conditions.push(eq(agentExpert.disabled, false));
  }
  return (
    db
      .select()
      .from(agentExpert)
      .where(and(...conditions))
      // 布尔列升序时 false（自建）在前；desc 让内置（true）排前，与注释语义一致
      .orderBy(desc(agentExpert.builtin), agentExpert.name)
  );
}

/** 按 ID 批量读取专家行（不校验可见性，调用方负责） */
export async function getExpertsByIds(ids: string[]): Promise<AgentExpertRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(agentExpert).where(inArray(agentExpert.id, ids));
}

/** 按 (organizationId, name) 读取单行 */
export async function getExpertByName(organizationId: string, name: string): Promise<AgentExpertRow | null> {
  const rows = await db
    .select()
    .from(agentExpert)
    .where(and(eq(agentExpert.organizationId, organizationId), eq(agentExpert.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

/** 按 ID 读取单行（含跨组织，调用方负责可见性校验） */
export async function getExpertById(id: string): Promise<AgentExpertRow | null> {
  const rows = await db.select().from(agentExpert).where(eq(agentExpert.id, id)).limit(1);
  return rows[0] ?? null;
}

/** 创建专家（组织自建，builtin=false） */
export async function createExpert(input: AgentExpertInsert): Promise<AgentExpertRow> {
  const [row] = await db.insert(agentExpert).values(input).returning();
  return row;
}

/** 更新专家（按 ID；system 行由上层拒绝后不会走到这里） */
export async function updateExpert(id: string, set: Partial<AgentExpertInsert>): Promise<AgentExpertRow | null> {
  const [row] = await db
    .update(agentExpert)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(agentExpert.id, id))
    .returning();
  return row ?? null;
}

/** 物理删除专家（组织自建；引用由 DB 级联清理） */
export async function deleteExpert(id: string): Promise<boolean> {
  const result = await db.delete(agentExpert).where(eq(agentExpert.id, id)).returning({ id: agentExpert.id });
  return result.length > 0;
}

/** 软删除/恢复内置专家（决策 D3：模板文件删除 → disabled，不物理删除） */
export async function setExpertDisabled(id: string, disabled: boolean): Promise<boolean> {
  const result = await db
    .update(agentExpert)
    .set({ disabled, updatedAt: new Date() })
    .where(eq(agentExpert.id, id))
    .returning({ id: agentExpert.id });
  return result.length > 0;
}

/** 按组织名幂等 upsert（内置同步用；onConflictDoUpdate 保证多实例并发启动安全） */
export async function upsertExpertByOrgName(
  organizationId: string,
  input: Omit<AgentExpertInsert, "organizationId"> & { name: string },
): Promise<AgentExpertRow> {
  const [row] = await db
    .insert(agentExpert)
    .values({ ...input, organizationId })
    .onConflictDoUpdate({
      target: [agentExpert.organizationId, agentExpert.name],
      set: { ...input, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/** 列出所有内置（system）专家行 */
export async function listAllBuiltinExperts(): Promise<AgentExpertRow[]> {
  return db.select().from(agentExpert).where(eq(agentExpert.organizationId, "system"));
}

// ── 引用（agent_config_expert）──

/** 列出主 Agent 引用的全部专家 ID（保持引用顺序） */
export async function listExpertIdsByAgent(agentConfigId: string): Promise<string[]> {
  const rows = await db
    .select({ expertId: agentConfigExpert.expertId })
    .from(agentConfigExpert)
    .where(eq(agentConfigExpert.agentConfigId, agentConfigId))
    .orderBy(agentConfigExpert.createdAt, agentConfigExpert.expertId);
  return rows.map((r) => r.expertId);
}

/** 事务内全量覆盖主 Agent 的专家引用（先删后插；事务保证并发覆盖不产生中间态） */
export async function syncAgentExperts(agentConfigId: string, expertIds: string[]): Promise<void> {
  const valid = expertIds.filter((id) => id?.trim());
  await db.transaction(async (tx) => {
    await tx.delete(agentConfigExpert).where(eq(agentConfigExpert.agentConfigId, agentConfigId));
    if (valid.length === 0) return;
    await tx.insert(agentConfigExpert).values(
      valid.map((expertId, index) => ({
        agentConfigId,
        expertId,
        // PG now() 是事务时间戳，同批 insert 完全相同，orderBy(createdAt) 会退化为
        // expertId 字典序；显式按插入顺序递增 createdAt，保证引用顺序可恢复（L3）
        createdAt: new Date(Date.now() + index),
      })),
    );
  });
}
