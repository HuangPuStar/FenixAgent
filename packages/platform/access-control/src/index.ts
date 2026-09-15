import { requestAls } from "@fenix/logger";
import type {
  AccessControlModule,
  ActorContext,
  AuthorizationInput,
  ResourceAccess,
  ResourceAction,
  ResourceDefinition,
  ResourceScope,
  ResourceScopeStore,
  ResourceScopeStoreBinding,
} from "@fenix/platform-sdk";

export interface DefaultAccessControlOptions {
  readonly resolveActor?: (actorId: string) => Promise<ActorContext>;
  readonly scopeStore?: ResourceScopeStore;
}

/** 默认授权实现：只解释可信 actor、ResourceScope 和资源声明，不返回 SQL。 */
export class DefaultAccessControl implements AccessControlModule, ResourceScopeStoreBinding {
  readonly id = "access-control";
  private scopeStore?: ResourceScopeStore;
  private readonly resolveActor: (actorId: string) => Promise<ActorContext>;

  constructor(options: DefaultAccessControlOptions = {}) {
    this.scopeStore = options.scopeStore;
    this.resolveActor = options.resolveActor ?? defaultActorResolver;
  }

  bindResourceScopeStore(store: ResourceScopeStore): void {
    this.scopeStore = store;
  }

  createActorContext(input: { actorId: string }): Promise<ActorContext> {
    return this.resolveActor(input.actorId);
  }

  async initializeResourceAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void> {
    const organizationId = input.resource.ownershipMode === "personal" ? undefined : input.actor.activeOrganizationId;
    if (input.resource.ownershipMode !== "personal" && !organizationId) {
      throw new Error("资源创建需要当前组织上下文");
    }
    await this.requireScopeStore().initialize({
      resourceType: input.resource.type,
      resourceId: input.resourceId,
      scope: { organizationId, ownerUserId: input.actor.userId, visibility: "private" },
    });
  }

  async authorize(input: AuthorizationInput): Promise<void> {
    const scope = await this.getScope(input.resource, input.resourceId);
    if (!this.resolveActions(input.actor, input.resource, scope).includes(input.action)) {
      throw new Error("当前主体无权执行资源动作");
    }
  }

  createListConstraint(input: { actor: ActorContext; resource: ResourceDefinition; action: "read" | "use" }) {
    return { resourceType: input.resource.type, action: input.action } as const;
  }

  async resolveAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<ResourceAccess> {
    const scope = await this.getScope(input.resource, input.resourceId);
    return { actions: this.resolveActions(input.actor, input.resource, scope) };
  }

  private resolveActions(
    actor: ActorContext,
    resource: ResourceDefinition,
    scope: ResourceScope,
  ): readonly ResourceAction[] {
    if (actor.systemRole === "super-admin") return resource.actions;
    const sameOrganization = scope.organizationId === undefined || actor.activeOrganizationId === scope.organizationId;
    if (resource.ownershipMode === "personal" && scope.ownerUserId === actor.userId) return resource.actions;
    if (resource.ownershipMode === "organization-personal" && sameOrganization && scope.ownerUserId === actor.userId) {
      return resource.actions;
    }

    const membership = sameOrganization
      ? actor.memberships.find((item) => item.organizationId === scope.organizationId)
      : undefined;
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
    if (!scope) throw new Error("资源缺少归属范围");
    return scope;
  }

  private requireScopeStore(): ResourceScopeStore {
    if (!this.scopeStore) throw new Error("AccessControl 未装配 ResourceScopeStore");
    return this.scopeStore;
  }
}

async function defaultActorResolver(actorId: string): Promise<ActorContext> {
  const requestContext = requestAls.getStore();
  if (requestContext?.userId && requestContext.userId !== actorId) throw new Error("actor 与认证主体不一致");
  const organizationId = requestContext?.organizationId;
  return {
    kind: "user",
    userId: actorId,
    ...(organizationId ? { activeOrganizationId: organizationId } : {}),
    memberships: organizationId ? [{ organizationId, role: requestContext?.role ?? "member" }] : [],
  };
}

export function createDefaultAccessControl(options: DefaultAccessControlOptions = {}): DefaultAccessControl {
  return new DefaultAccessControl(options);
}
