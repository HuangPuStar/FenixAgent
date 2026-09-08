import { type AccessControlModule, AuthorizedResourceFacade } from "@fenix-ce/platform-sdk";
import {
  type AgentConfig,
  AgentConfigDomainService,
  type AgentConfigListQuery,
  type AgentConfigPage,
  type CreateAgentConfigInput,
  type ListAgentConfigsInput,
  type UpdateAgentConfigInput,
} from "../domain/agent-config";
import { InMemoryAgentConfigRepository } from "../repositories/in-memory-agent-config-repository";

/**
 * AgentConfig 授权通过后提供给运行时的配置快照。
 *
 * 这是资源层自己的输出类型，避免 resources 反向依赖 runtime。运行时只消费同形的启动参数。
 */
export interface AuthorizedAgentLaunchSpec {
  readonly agentConfigId: string;
  readonly engine: string;
}

/** AgentConfig 的权限 Facade；“use” 权限在这里判定，而不在 InstanceManager 中判定。 */
export class AgentConfigFacade extends AuthorizedResourceFacade<AgentConfig, AgentConfigListQuery> {
  private readonly domain = new AgentConfigDomainService();

  constructor(accessControl: AccessControlModule) {
    super(accessControl, new InMemoryAgentConfigRepository(), "agent-config");
  }

  async create(input: CreateAgentConfigInput): Promise<AgentConfig> {
    return this.createAuthorized(input.actorId, (ownershipScope) => ({
      ...this.domain.create(input),
      ownershipScope,
    }));
  }

  async get(input: { actorId: string; agentConfigId: string }): Promise<AgentConfig> {
    return this.getAuthorized(input.actorId, input.agentConfigId);
  }

  async list(input: ListAgentConfigsInput): Promise<AgentConfigPage> {
    return this.listAuthorized(input.actorId, { limit: input.limit, keyword: input.keyword });
  }

  async update(input: UpdateAgentConfigInput): Promise<AgentConfig> {
    return this.updateAuthorized(input.actorId, input.agentConfigId, (config) => ({
      ...this.domain.update({ resourceId: config.id, name: config.name, engine: config.engine }, input),
      id: config.id,
      ownershipScope: config.ownershipScope,
    }));
  }

  async delete(input: { actorId: string; agentConfigId: string }): Promise<void> {
    await this.deleteAuthorized(input.actorId, input.agentConfigId);
  }

  async resolveForRun(input: { actorId: string; agentConfigId: string }): Promise<AuthorizedAgentLaunchSpec> {
    const config = await this.getAuthorizedAgentConfig(input.actorId, input.agentConfigId, "use");
    return this.toLaunchSpec(config);
  }

  /** EE 发布 Facade 可复用 use 授权，但不能绕过资源查询约束。 */
  protected async getAuthorizedAgentConfig(
    actorId: string,
    agentConfigId: string,
    action: string,
  ): Promise<AgentConfig> {
    return this.getAuthorizedResource(actorId, agentConfigId, action);
  }

  protected toLaunchSpec(config: AgentConfig): AuthorizedAgentLaunchSpec {
    return { agentConfigId: config.id, engine: config.engine };
  }
}
