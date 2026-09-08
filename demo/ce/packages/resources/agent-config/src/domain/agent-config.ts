import type { ResourcePage, ResourceScope } from "@fenix-ce/platform-sdk";

/** AgentConfig 专属属性表；归属与权限不属于此对象。 */
export interface AgentConfigProperties {
  readonly resourceId: string;
  readonly name: string;
  readonly engine: string;
}

/** 应用层读模型：资源基表的 ID/归属与 AgentConfig 属性表组合后提供给调用方。 */
export interface AgentConfig {
  readonly id: string;
  readonly name: string;
  readonly engine: string;
  readonly ownershipScope: ResourceScope;
}

export interface CreateAgentConfigInput {
  readonly actorId: string;
  readonly name: string;
  readonly engine: string;
}

export interface UpdateAgentConfigInput {
  readonly actorId: string;
  readonly agentConfigId: string;
  readonly name: string;
}

export interface AgentConfigListQuery {
  readonly limit: number;
  readonly keyword?: string;
}

export interface ListAgentConfigsInput extends AgentConfigListQuery {
  readonly actorId: string;
}

export type AgentConfigPage = ResourcePage<AgentConfig>;

/** 纯领域规则：不认识 actor、授权、资源归属或 InstanceManager。 */
export class AgentConfigDomainService {
  create(input: CreateAgentConfigInput): Omit<AgentConfigProperties, "resourceId"> {
    return { name: this.requireName(input.name), engine: this.requireEngine(input.engine) };
  }

  update(config: AgentConfigProperties, input: UpdateAgentConfigInput): AgentConfigProperties {
    return { ...config, name: this.requireName(input.name) };
  }

  private requireName(name: string): string {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("AgentConfig 名称不能为空");
    return normalizedName;
  }

  private requireEngine(engine: string): string {
    const normalizedEngine = engine.trim();
    if (!normalizedEngine) throw new Error("AgentConfig 必须选择引擎");
    return normalizedEngine;
  }
}
