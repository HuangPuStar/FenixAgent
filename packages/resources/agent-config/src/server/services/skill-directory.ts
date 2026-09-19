/**
 * agent-config 侧读取 Skill 的适配层。
 *
 * Agent 的 skill 绑定（`agent_config_skill`）与智能生成只需要「当前主体可见的 Skill 的 id / 名称 /
 * 描述」，不需要 Skill 的授权语义，也不该知道 `skill` 表的形状。这里把 Skill 资源的应用 Facade
 * 投影成这个最小形状：可见性规则仍只有一份（在 Skill 的 Facade 与授权栈里），agent-config 不复制
 * 「哪些 Skill 可见」的判断。
 *
 * `ActorContext` 由调用方从请求上下文透传，本层不做身份解释（宿主是唯一的主体转换点）。
 */

import type { ActorContext } from "@fenix/platform-sdk";
import { getSkillServerModule } from "@fenix/resource-skill/server/runtime";

/** Agent 绑定与生成所需的最小 Skill 投影。 */
export interface VisibleSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** 列出当前主体可见的 Skill（含其他组织公开的只读 Skill）。 */
export async function listVisibleSkills(actor: ActorContext): Promise<VisibleSkill[]> {
  const { items } = await getSkillServerModule().facade.list(actor);
  return items.map((item) => ({ id: item.id, name: item.name, description: item.description }));
}
