import { agentConfigSkill } from "@fenix/agent-config/db";
import { eq } from "drizzle-orm";
import { getAgentConfigDatabase } from "../db";

/**
 * Agent ↔ Skill 关联边的持久化访问。
 *
 * 关联表随 Agent 配置聚合根迁入本包（任务 1.7 B7），读写口径因此只有这一处——`agent_config_skill`
 * 是「这个 Agent 关联了哪些技能」这条边本身，不是 Skill 资源行：资源行的授权读写走 skill 包的组合根
 * 与 Facade，关联 id 的展示标签由 `@fenix/resource-skill/server/config` 的 `findSkillLabelsByIds`
 * 提供（本包只给出 id 集合）。
 *
 * 迁入前它在 skill 包，分了两层（`repositories/agent-config-skill.ts` 的 SQL + `services/config/`
 * 的同名直通）；表与读写同属本包后，转调那一层不再有理由，因此合并为一个文件。唯一的调用方是本包的
 * `services/agent-associations.ts`。DB 句柄在函数内取，不持有模块级连接。
 */

/** 查询指定 Agent 关联的全部 skillId。 */
export async function listAgentSkillIds(agentConfigId: string): Promise<string[]> {
  const rows = await getAgentConfigDatabase()
    .select({ skillId: agentConfigSkill.skillId })
    .from(agentConfigSkill)
    .where(eq(agentConfigSkill.agentConfigId, agentConfigId));
  return rows.map((row) => row.skillId);
}

/**
 * 全量覆盖指定 Agent 的技能关联（先删后插）。
 *
 * 两条语句不包事务：`agentConfigSkill` 上没有唯一约束以外的约束，且当前调用点（控制台保存 Agent
 * 配置、`services/agent-bindings.ts`）本身就运行在宿主既有的事务语义之外；引入事务会改变锁范围，
 * 超出本次边界收敛的范围。若后续要原子化应改在 service 层事务里。
 */
export async function syncAgentSkills(agentConfigId: string, skillIds: readonly string[]): Promise<void> {
  await getAgentConfigDatabase().delete(agentConfigSkill).where(eq(agentConfigSkill.agentConfigId, agentConfigId));

  // 空串与纯空白是"未选择"，不是有效 id：写入它们会让关联指向不存在的技能。
  const valid = skillIds.map((id) => id?.trim()).filter((id): id is string => Boolean(id));
  if (valid.length === 0) return;

  await getAgentConfigDatabase()
    .insert(agentConfigSkill)
    .values(valid.map((skillId) => ({ agentConfigId, skillId })));
}
