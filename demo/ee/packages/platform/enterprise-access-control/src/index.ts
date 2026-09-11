import type {
  AccessControlModule,
  ActorContext,
  AuthorizationInput,
  ResourceAccess,
  ResourceDefinition,
  ResourceScope,
  ResourceScopeStore,
  ResourceScopeStoreBinding,
} from "@fenix-ce/platform-sdk";

/** EE 使用工作空间作为组织范围的实现细节；资源包仍只看到 ResourceScope。 */
const ACTOR_HOME_WORKSPACE: Readonly<Record<string, string>> = {
  wang: "workspace-finance",
  li: "workspace-shared",
};

/** wang 可读共享空间但默认在 finance 创建资源；li 负责 shared 空间。 */
const ACTOR_ACCESSIBLE_WORKSPACE_IDS: Readonly<Record<string, readonly string[]>> = {
  wang: ["workspace-finance", "workspace-shared"],
  li: ["workspace-shared"],
};

/** EE 完整替换 CE 的身份、租户和授权模型，可对接客户 SSO、LDAP 与 ABAC。 */
export class EnterpriseAccessControl implements AccessControlModule, ResourceScopeStoreBinding {
  readonly id = "ee-enterprise-access-control";
  private scopeStore?: ResourceScopeStore;

  bindResourceScopeStore(store: ResourceScopeStore): void {
    this.scopeStore = store;
  }

  async createActorContext({ actorId }: { actorId: string }): Promise<ActorContext> {
    const workspaceId = ACTOR_HOME_WORKSPACE[actorId];
    if (!workspaceId) throw new Error("EE: 外部身份未映射到可用工作空间");
    return {
      kind: "user",
      userId: actorId,
      activeOrganizationId: workspaceId,
      memberships: (ACTOR_ACCESSIBLE_WORKSPACE_IDS[actorId] ?? []).map((organizationId) => ({
        organizationId,
        role: organizationId === workspaceId ? "owner" : "member",
      })),
    };
  }

  async initializeResourceAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void> {
    await this.requireScopeStore().initialize({
      resourceType: input.resource.type,
      resourceId: input.resourceId,
      scope: {
        organizationId: input.resource.ownershipMode === "personal" ? undefined : input.actor.activeOrganizationId,
        ownerUserId: input.actor.userId,
        visibility: "private",
      },
    });
  }

  createListConstraint(input: { actor: ActorContext; resource: ResourceDefinition; action: "read" | "use" }) {
    return {
      resourceType: input.resource.type,
      action: input.action,
      matches: (scope: ResourceScope) => this.resolveActions(input.actor, input.resource, scope).includes(input.action),
    };
  }

  async authorize({ actor, action, resource, resourceId }: AuthorizationInput): Promise<void> {
    const resourceScope = await this.getScope(resource, resourceId);
    if (!this.resolveActions(actor, resource, resourceScope).includes(action)) {
      throw new Error("EE: 企业工作空间无权访问此资源");
    }
  }

  async resolveAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<ResourceAccess> {
    return {
      actions: this.resolveActions(input.actor, input.resource, await this.getScope(input.resource, input.resourceId)),
    };
  }

  /** EE 默认发布审批策略；资源专属扩展不反向进入通用 AccessControlModule。 */
  async authorizePublish(input: { actorId: string; agentConfigId: string; scope: ResourceScope }): Promise<void> {
    void input.agentConfigId;
    const actor = await this.createActorContext({ actorId: input.actorId });
    const membership = actor.memberships.find((item) => item.organizationId === input.scope.organizationId);
    if (
      actor.systemRole !== "super-admin" &&
      input.scope.ownerUserId !== actor.userId &&
      membership?.role !== "owner" &&
      membership?.role !== "admin"
    ) {
      throw new Error("EE: 无权发布此 AgentConfig");
    }
  }

  private resolveActions(actor: ActorContext, resource: ResourceDefinition, scope: ResourceScope) {
    if (actor.systemRole === "super-admin") return resource.actions;
    if (resource.ownershipMode !== "organization" && scope.ownerUserId === actor.userId) return resource.actions;

    const membership = actor.memberships.find((item) => item.organizationId === scope.organizationId);
    if (resource.ownershipMode === "organization" && (membership?.role === "owner" || membership?.role === "admin")) {
      return resource.actions;
    }
    if (resource.ownershipMode === "organization" && membership) return resource.memberDefaultActions;
    if (scope.visibility === "public") return resource.memberDefaultActions;
    return [];
  }

  private async getScope(resource: ResourceDefinition, resourceId: string): Promise<ResourceScope> {
    const scope = (
      await this.requireScopeStore().getMany({ resourceType: resource.type, resourceIds: [resourceId] })
    ).get(resourceId);
    if (!scope) throw new Error("EE: 资源缺少归属范围");
    return scope;
  }

  private requireScopeStore(): ResourceScopeStore {
    if (!this.scopeStore) throw new Error("EE: AccessControl 未装配 ResourceScopeStore");
    return this.scopeStore;
  }
}
