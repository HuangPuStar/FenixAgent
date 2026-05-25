import { eq } from "drizzle-orm";
import { db } from "../../db";
import { agentConfigSkill } from "../../db/schema";

/** 查询 Agent 关联的所有 skillId */
export async function listAgentSkillIds(agentConfigId: string): Promise<string[]> {
  const rows = await db
    .select({ skillId: agentConfigSkill.skillId })
    .from(agentConfigSkill)
    .where(eq(agentConfigSkill.agentConfigId, agentConfigId));
  return rows.map((r) => r.skillId);
}

/** 全量覆盖 Agent 的技能关联（先删后插） */
export async function syncAgentSkills(agentConfigId: string, skillIds: string[]): Promise<void> {
  await db.delete(agentConfigSkill).where(eq(agentConfigSkill.agentConfigId, agentConfigId));

  const valid = skillIds.filter((id) => id?.trim());
  if (valid.length === 0) return;

  await db.insert(agentConfigSkill).values(
    valid.map((skillId) => ({
      agentConfigId,
      skillId,
    })),
  );
}
