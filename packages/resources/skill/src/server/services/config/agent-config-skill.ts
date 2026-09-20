import {
  replaceAgentSkillIds as replaceAgentSkillIdsInRepository,
  selectAgentSkillIds,
} from "../../repositories/agent-config-skill";

/**
 * Agent ↔ Skill 关联的业务入口。
 *
 * 数据访问全部下沉到 `repositories/agent-config-skill.ts`；这里只保留语义命名与调用方稳定契约
 * （`@fenix/resource-skill/server/config` 对外导出这两个函数）。服务端与仓储的拆分不是为了转调一层，
 * 而是让"关联表由谁读写"只有一个答案：本包第一次出现第二处直连关联表的代码时就该收敛。
 */

/** 查询 Agent 关联的所有 skillId */
export async function listAgentSkillIds(agentConfigId: string): Promise<string[]> {
  return selectAgentSkillIds(agentConfigId);
}

/** 全量覆盖 Agent 的技能关联（先删后插） */
export async function syncAgentSkills(agentConfigId: string, skillIds: string[]): Promise<void> {
  await replaceAgentSkillIdsInRepository(agentConfigId, skillIds);
}
