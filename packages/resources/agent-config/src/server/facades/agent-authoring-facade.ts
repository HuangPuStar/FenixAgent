import type { ActorContext } from "@fenix/platform-sdk";
import { getSkillServerModule } from "@fenix/resource-skill/server/runtime";
import type { AgentAssociations } from "../services/agent-associations";
import { type AgentBindingRequest, isSkillIdentifier, resolveSkillIdentifiers } from "../services/agent-bindings";
import { type AgentGenerationResult, generateAgentConfig, type VisibleSkill } from "../services/agent-generation";

/**
 * Agent 编写面（智能生成 + 关联绑定）的 Facade。
 *
 * 这一层存在的理由是 `ActorContext` 的边界：生成要按主体可见性挑选候选 Skill，绑定要把 Skill 名称解析
 * 成 ID，两者都需要"当前主体能看到哪些 Skill"——但那是 **Skill 资源**的授权结论，只能由 Skill 的 Facade
 * 拿着 actor 产出（§3.2：跨资源读取授权由发起动作的 Facade 完成）。因此主体留在这一层，领域服务只接收
 * 已算好的显式参数（提示词、可见 Skill 投影、已解析的 ID 集合）。
 *
 * 与 `facades/agent-config-facade.ts` 的分工：那边是 AgentConfig 资源行本身的授权与生命周期，这边是
 * "以某个主体的身份编写 Agent 配置"的应用动作，不触碰资源行的归属与可见性。
 */
export interface AgentAuthoringFacadeApi {
  /** 当前主体可见的 Skill 投影（含其他组织公开的只读 Skill）。 */
  listVisibleSkills(actor: ActorContext): Promise<VisibleSkill[]>;
  /** 智能生成：候选 Skill 已按主体可见范围收敛，生成结果可以直接绑定。 */
  generate(actor: ActorContext, prompt: string): Promise<AgentGenerationResult>;
  /** 把 Skill 名称解析为 ID；名称只在当前主体可见的 Skill 里解析。 */
  resolveSkillIds(actor: ActorContext, identifiers: readonly string[]): Promise<string[]>;
  /**
   * 把请求里的绑定写入绑定表；未出现的字段保持原样。
   *
   * `skillIds` 在这里解析成 UUID 后再交给领域服务，因此领域服务不需要 actor，也不会因为知道名称而
   * 引用到不可见的 Skill。
   */
  applyBindings(actor: ActorContext, agentConfigId: string, request: AgentBindingRequest): Promise<void>;
}

export class AgentAuthoringFacade implements AgentAuthoringFacadeApi {
  constructor(private readonly associations: AgentAssociations) {}

  async listVisibleSkills(actor: ActorContext): Promise<VisibleSkill[]> {
    const { items } = await getSkillServerModule().facade.list(actor);
    return items.map((item) => ({ id: item.id, name: item.name, description: item.description }));
  }

  async generate(actor: ActorContext, prompt: string): Promise<AgentGenerationResult> {
    return generateAgentConfig({ prompt, skills: await this.listVisibleSkills(actor) });
  }

  async resolveSkillIds(actor: ActorContext, identifiers: readonly string[]): Promise<string[]> {
    // UUID 输入直接通过：不需要按名称解析，也就不必读可见范围（省一次跨资源调用）。
    if (identifiers.length === 0 || identifiers.every(isSkillIdentifier)) return [...identifiers];
    return resolveSkillIdentifiers({ identifiers, skills: await this.listVisibleSkills(actor) });
  }

  async applyBindings(actor: ActorContext, agentConfigId: string, request: AgentBindingRequest): Promise<void> {
    if (request.knowledge !== undefined) {
      await this.associations.syncKnowledge(agentConfigId, request.knowledge);
    }
    if (request.skillIds !== undefined) {
      await this.associations.syncSkills(agentConfigId, await this.resolveSkillIds(actor, request.skillIds));
    }
    if (request.mcpIds !== undefined) {
      await this.associations.syncMcps(agentConfigId, request.mcpIds);
    }
    if (request.siteAppIds !== undefined) {
      await this.associations.syncSiteApps(agentConfigId, request.siteAppIds);
    }
  }
}

/** 组合根构造器；绑定写入经注入的 {@link AgentAssociations} 门面，跨资源读取经 Skill 的 Facade。 */
export function createAgentAuthoringFacade(associations: AgentAssociations): AgentAuthoringFacade {
  return new AgentAuthoringFacade(associations);
}
