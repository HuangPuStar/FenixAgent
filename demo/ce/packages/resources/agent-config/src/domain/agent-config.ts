import type { ResourceDefinition, ResourcePage, ResourceRecord, ResourceVisibility } from "@fenix-ce/platform-sdk";

/** AgentConfig 资源包静态持有的访问定义；平台只解释此定义，不维护中央 registry。 */
export const agentConfigResourceDefinition = {
  type: "agent-config",
  ownershipMode: "organization",
  actions: ["read", "create", "update", "delete", "use"],
  memberDefaultActions: ["read", "use"],
} as const satisfies ResourceDefinition;

/** AgentConfig 专属属性表；资源范围不属于此对象。 */
export interface AgentConfigProperties {
  readonly resourceId: string;
  readonly name: string;
  readonly engine: string;
}

/** 应用层读模型：资源基表的 ID/范围与 AgentConfig 属性表组合后提供给调用方。 */
export type AgentConfig = ResourceRecord<{
  readonly id: string;
  readonly name: string;
  readonly engine: string;
}>;

export interface CreateAgentConfigInput {
  readonly actorId: string;
  readonly name: string;
  readonly engine: string;
}

/** Domain Service 只接收 AgentConfig 业务字段，不接触可信主体。 */
export interface CreateAgentConfigData {
  readonly name: string;
  readonly engine: string;
}

export interface UpdateAgentConfigInput {
  readonly actorId: string;
  readonly agentConfigId: string;
  readonly name: string;
}

/** Domain Service 的更新输入不携带 actor 或资源定位信息。 */
export interface UpdateAgentConfigData {
  readonly name: string;
}

export interface UpdateAgentConfigVisibilityInput {
  readonly actorId: string;
  readonly agentConfigId: string;
  readonly visibility: ResourceVisibility;
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
  create(input: CreateAgentConfigData): Omit<AgentConfigProperties, "resourceId"> {
    return { name: this.requireName(input.name), engine: this.requireEngine(input.engine) };
  }

  update(config: AgentConfigProperties, input: UpdateAgentConfigData): AgentConfigProperties {
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
