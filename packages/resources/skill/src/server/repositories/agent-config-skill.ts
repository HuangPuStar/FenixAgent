import { agentConfigSkill } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { getSkillDatabase } from "../db";

/**
 * Agent ↔ Skill 关联表的持久化访问。
 *
 * 关联表由本包声明并管理（表定义迁出归任务 1.7），因此它的读写收敛在这里：`services/config/`
 * 只保留业务语义（"关联了哪些技能" / "全量覆盖"），不再直接拼 SQL。
 */

/** 查询指定 Agent 关联的全部 skillId。 */
export async function selectAgentSkillIds(agentConfigId: string): Promise<string[]> {
  const rows = await getSkillDatabase()
    .select({ skillId: agentConfigSkill.skillId })
    .from(agentConfigSkill)
    .where(eq(agentConfigSkill.agentConfigId, agentConfigId));
  return rows.map((row) => row.skillId);
}

/**
 * 全量覆盖指定 Agent 的技能关联（先删后插）。
 *
 * 两条语句不包事务：`agentConfigSkill` 上没有唯一约束以外的约束，且当前调用点（控制台保存 Agent
 * 配置）本身就运行在宿主既有的事务语义之外；引入事务会改变锁范围，超出本次边界收敛的范围。
 * 收敛点在 `services/config/agent-config-skill.ts`，若后续要原子化应改在 service 层事务里。
 */
export async function replaceAgentSkillIds(agentConfigId: string, skillIds: readonly string[]): Promise<void> {
  await getSkillDatabase().delete(agentConfigSkill).where(eq(agentConfigSkill.agentConfigId, agentConfigId));

  // 空串与纯空白是"未选择"，不是有效 id：写入它们会让关联指向不存在的技能。
  const valid = skillIds.map((id) => id?.trim()).filter((id): id is string => Boolean(id));
  if (valid.length === 0) return;

  await getSkillDatabase()
    .insert(agentConfigSkill)
    .values(valid.map((skillId) => ({ agentConfigId, skillId })));
}
