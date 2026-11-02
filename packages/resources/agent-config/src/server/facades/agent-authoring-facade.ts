import type { ActorContext } from "@fenix/platform-sdk";
import { runInTransaction } from "@fenix/platform-sdk/server";
import { InvalidKnowledgeBindingError } from "@fenix/resource-knowledge/server";
import { getSkillServerModule } from "@fenix/resource-skill/server/runtime";
import type { AgentAssociations } from "../services/agent-associations";
import { type AgentBindingRequest, isSkillIdentifier, resolveSkillIdentifiers } from "../services/agent-bindings";
import { type AgentGenerationResult, generateAgentConfig, type VisibleSkill } from "../services/agent-generation";
import type { AuthorizedAgentConfig } from "./agent-config-facade";

/**
 * Agent 编写面（智能生成 + 关联绑定）的 Facade。
 *
 * 这一层存在的理由是 `ActorContext` 的边界：生成要按主体可见性挑选候选 Skill，绑定要把 Skill 名称解析
 * 成 ID，两者都需要"当前主体能看到哪些 Skill"——但那是 **Skill 资源**的授权结论，只能由 Skill 的 Facade
 * 拿着 actor 产出（§3.2：跨资源读取授权由发起动作的 Facade 完成）。因此主体留在这一层，领域服务只接收
 * 已算好的显式参数（提示词、可见 Skill 投影、已解析的 ID 集合）。
 *
 * 与 `facades/agent-config-facade.ts` 的分工：那边是 AgentConfig 资源行本身的授权与生命周期，这边是
 * "以某个主体的身份编写 Agent 配置"的应用动作。保存事务在本层编排，配置行的授权与写入仍由资源 Facade 执行。
 */
export interface AgentAuthoringFacadeApi {
  /** 原子保存配置、记忆开关和显式绑定；配置写入回调必须经 AgentConfigFacade 完成授权。 */
  save(
    actor: ActorContext,
    persist: () => Promise<AuthorizedAgentConfig>,
    request: AgentBindingRequest,
    options?: { enableMemory?: boolean },
  ): Promise<AuthorizedAgentConfig>;
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
   * 引用到不可见的 Skill。`organizationId` 是刚保存的 Agent 归属组织，知识库绑定按它校验归属。
   */
  applyBindings(
    actor: ActorContext,
    agentConfigId: string,
    organizationId: string | undefined,
    request: AgentBindingRequest,
  ): Promise<void>;
}

export class AgentAuthoringFacade implements AgentAuthoringFacadeApi {
  constructor(private readonly associations: AgentAssociations) {}

  /** 所有参与保存的仓储通过平台事务上下文使用同一连接，异常原样抛出并整体回滚。 */
  async save(
    actor: ActorContext,
    persist: () => Promise<AuthorizedAgentConfig>,
    request: AgentBindingRequest,
    options: { enableMemory?: boolean } = {},
  ): Promise<AuthorizedAgentConfig> {
    return runInTransaction(async () => {
      const agent = await persist();
      if (options.enableMemory !== undefined) {
        await this.associations.setMemoryEnabled(agent.id, options.enableMemory);
      }
      await this.applyBindings(actor, agent.id, agent.scope.organizationId, request);
      return agent;
    });
  }

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

  async applyBindings(
    actor: ActorContext,
    agentConfigId: string,
    organizationId: string | undefined,
    request: AgentBindingRequest,
  ): Promise<void> {
    if (request.knowledge !== undefined) {
      // 归属组织在库里非空，投影类型是通用的可空形状；收窄失败说明读到了不合规的行，按绑定非法拒绝。
      if (organizationId === undefined) {
        throw new InvalidKnowledgeBindingError("Agent 缺少归属组织，无法校验知识库绑定");
      }
      await this.associations.syncKnowledge(agentConfigId, request.knowledge, organizationId);
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
