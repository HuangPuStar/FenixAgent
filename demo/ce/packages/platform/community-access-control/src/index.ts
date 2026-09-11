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

const OPEN_SOURCE_ORGANIZATION_ID = "org-open-source";

/**
 * CE 默认的用户—组织—角色授权实现。
 *
 * 真实实现可在此对接成员关系与角色表；资源包只依赖 AccessControlModule，不依赖其内部模型。
 */
export class CommunityAccessControl implements AccessControlModule, ResourceScopeStoreBinding {
  readonly id = "ce-access-control";
  private scopeStore?: ResourceScopeStore;

  bindResourceScopeStore(store: ResourceScopeStore): void {
    this.scopeStore = store;
  }

  async createActorContext({ actorId }: { actorId: string }): Promise<ActorContext> {
    return {
      kind: "user",
      userId: actorId,
      activeOrganizationId: OPEN_SOURCE_ORGANIZATION_ID,
      memberships: [{ organizationId: OPEN_SOURCE_ORGANIZATION_ID, role: "owner" }],
    };
  }

  async initializeResourceAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void> {
    const isOrganizationResource = input.resource.ownershipMode !== "personal";
    await this.requireScopeStore().initialize({
      resourceType: input.resource.type,
      resourceId: input.resourceId,
      scope: {
        organizationId: isOrganizationResource ? input.actor.activeOrganizationId : undefined,
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
      throw new Error("CE: 当前组织无权访问此资源");
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

  private resolveActions(actor: ActorContext, resource: ResourceDefinition, scope: ResourceScope) {
    if (actor.systemRole === "super-admin") return resource.actions;
    if (resource.ownershipMode !== "organization" && scope.ownerUserId === actor.userId) return resource.actions;

    const membership = actor.memberships.find((item) => item.organizationId === scope.organizationId);
    if (resource.ownershipMode === "organization" && (membership?.role === "owner" || membership?.role === "admin")) {
      return resource.actions;
    }
    if (resource.ownershipMode === "organization" && membership) return resource.memberDefaultActions;
    return scope.visibility === "public" ? resource.memberDefaultActions : [];
  }

  private async getScope(resource: ResourceDefinition, resourceId: string): Promise<ResourceScope> {
    const scope = (
      await this.requireScopeStore().getMany({ resourceType: resource.type, resourceIds: [resourceId] })
    ).get(resourceId);
    if (!scope) throw new Error("CE: 资源缺少归属范围");
    return scope;
  }

  private requireScopeStore(): ResourceScopeStore {
    if (!this.scopeStore) throw new Error("CE: AccessControl 未装配 ResourceScopeStore");
    return this.scopeStore;
  }
}
