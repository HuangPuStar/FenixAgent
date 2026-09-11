import {
  type AgentConfig,
  AgentConfigFacade,
  type AgentConfigPage,
  type CreateAgentConfigInput,
  InMemoryAgentConfigRepository,
  type ListAgentConfigsInput,
} from "@fenix-ce/agent-config";
import type { ResourceModule } from "@fenix-ce/platform-sdk";
import type { AgentConfigApprovalPolicy } from "./services/agent-config-approval-policy";

export type PublicationStatus = "draft" | "active";

/** EE 独有的 AgentConfig 发布状态；基础配置表不增加商业字段。 */
class InMemoryAgentConfigPublicationRepository {
  private readonly statuses = new Map<string, PublicationStatus>();

  createDraft(agentConfigId: string): void {
    this.statuses.set(agentConfigId, "draft");
  }

  activate(agentConfigId: string): void {
    this.statuses.set(agentConfigId, "active");
  }

  getStatus(agentConfigId: string): PublicationStatus | undefined {
    return this.statuses.get(agentConfigId);
  }
}

export interface EnterpriseAgentConfig extends AgentConfig {
  readonly publicationStatus: PublicationStatus;
}

export interface EnterpriseAgentConfigPage extends Omit<AgentConfigPage, "items"> {
  readonly items: readonly EnterpriseAgentConfig[];
}

/** EE 发布决定 AgentConfig 能否被 use；InstanceManager 本身没有权限逻辑。 */
export class EnterpriseAgentConfigFacade extends AgentConfigFacade {
  private readonly publications = new InMemoryAgentConfigPublicationRepository();

  constructor(
    accessControl: ConstructorParameters<typeof AgentConfigFacade>[0],
    private readonly approvalPolicy: AgentConfigApprovalPolicy,
    repository?: InMemoryAgentConfigRepository,
  ) {
    super(accessControl, repository);
  }

  override async create(input: CreateAgentConfigInput): Promise<EnterpriseAgentConfig> {
    const config = await super.create(input);
    this.publications.createDraft(config.id);
    return this.toEnterpriseAgentConfig(config);
  }

  override async list(input: ListAgentConfigsInput): Promise<EnterpriseAgentConfigPage> {
    const page = await super.list(input);
    return { ...page, items: page.items.map((config) => this.toEnterpriseAgentConfig(config)) };
  }

  async publish(input: { actorId: string; agentConfigId: string }): Promise<EnterpriseAgentConfig> {
    // 发布是 AgentConfig 的专属状态机；先复用通用 update 授权，再进入 EE 审批端口。
    const config = await this.getAuthorizedAgentConfig(input.actorId, input.agentConfigId, "update");
    await this.approvalPolicy.authorizePublish({
      actorId: input.actorId,
      agentConfigId: config.id,
      scope: config.scope,
    });
    this.publications.activate(config.id);
    return this.toEnterpriseAgentConfig(config);
  }

  override async resolveForRun(input: { actorId: string; agentConfigId: string }) {
    const config = await this.getAuthorizedAgentConfig(input.actorId, input.agentConfigId, "use");
    if (this.toEnterpriseAgentConfig(config).publicationStatus !== "active") {
      throw new Error("AgentConfig 尚未发布");
    }
    return this.toLaunchSpec(config);
  }

  private toEnterpriseAgentConfig(config: AgentConfig): EnterpriseAgentConfig {
    const publicationStatus = this.publications.getStatus(config.id);
    if (!publicationStatus) {
      throw new Error("AgentConfig 缺少商业版发布状态");
    }
    return { ...config, publicationStatus };
  }
}

export const agentConfigPublicationModule: ResourceModule = {
  id: "agent-config-publication",
  schema: "agent_config_publications(agent_config_id, status)",
  migrations: ["0001_create_agent_config_publications"],
  apiContribution: ["/app/agent-configs/:id/publish"],
  webContribution: ["/agent-configs/:id/publish"],
  capabilities: ["agent-config:publish"],
};

export * from "./routes/app-routes";
export * from "./services/agent-config-approval-policy";
