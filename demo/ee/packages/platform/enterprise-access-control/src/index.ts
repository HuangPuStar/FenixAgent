import type { AccessControlModule, AuthorizationInput, ResourceContext, ResourceScope } from "@fenix-ce/platform-sdk";

const ACTOR_HOME_WORKSPACE: Readonly<Record<string, ResourceScope>> = {
  wang: { kind: "workspace", id: "workspace-finance" },
  li: { kind: "workspace", id: "workspace-shared" },
};

/** wang 可读共享空间但默认在 finance 创建资源；li 负责向 shared 空间创建共享资源。 */
const ACTOR_ACCESSIBLE_WORKSPACE_IDS: Readonly<Record<string, readonly string[]>> = {
  wang: ["workspace-finance", "workspace-shared"],
  li: ["workspace-shared"],
};

/** EE 完整替换 CE 的身份、租户和授权模型，可对接客户 SSO、LDAP 与 ABAC。 */
export class EnterpriseAccessControl implements AccessControlModule {
  readonly id = "ee-enterprise-access-control";

  async createResourceContext({ actorId }: { actorId: string }): Promise<ResourceContext> {
    const scope = ACTOR_HOME_WORKSPACE[actorId];
    if (!scope) {
      throw new Error("EE: 外部身份未映射到可用工作空间");
    }
    return { subject: { id: actorId, type: "external" }, scope };
  }

  buildResourceQueryConstraint(context: ResourceContext) {
    const accessibleWorkspaceIds = ACTOR_ACCESSIBLE_WORKSPACE_IDS[context.subject.id] ?? [];
    return {
      matches: (scope: ResourceScope) => scope.kind === "workspace" && accessibleWorkspaceIds.includes(scope.id),
    };
  }

  async authorize({ actorId, action, resourceScope }: AuthorizationInput): Promise<void> {
    const accessibleWorkspaceIds = ACTOR_ACCESSIBLE_WORKSPACE_IDS[actorId];
    if (!accessibleWorkspaceIds?.includes(resourceScope.id)) {
      throw new Error("EE: 企业工作空间无权访问此资源");
    }
    if (
      action !== "agent-config:read" &&
      action !== "agent-config:write" &&
      action !== "agent-config:list" &&
      action !== "agent-config:use" &&
      action !== "agent-config:publish"
    ) {
      throw new Error(`EE: 不支持的资源操作 ${action}`);
    }
  }

  /** EE 默认发布审批策略；结构上满足 resources 定义的窄端口，但 platform 不反向依赖资源包。 */
  async authorizePublish(input: {
    actorId: string;
    agentConfigId: string;
    ownershipScope: ResourceScope;
  }): Promise<void> {
    void input.agentConfigId;
    await this.authorize({
      actorId: input.actorId,
      action: "agent-config:publish",
      resourceScope: input.ownershipScope,
    });
  }
}
