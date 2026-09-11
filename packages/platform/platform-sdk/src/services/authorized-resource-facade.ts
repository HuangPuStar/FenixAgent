import type {
  AccessControlModule,
  ActorContext,
  ResourceAction,
  ResourceDefinition,
  ResourceScope,
  ResourceScopeStore,
} from "../index";
import type { ResourcePage, ScopedResource, ScopedResourceRepository } from "../resource/scoped-resource";
import { AuthorizedResourceQuery } from "./authorized-resource-query";

/** 统一资源授权编排；资源字段校验和状态机仍归资源自身 service。 */
export class AuthorizedResourceFacade<TResource extends ScopedResource, TListQuery> {
  constructor(
    protected readonly accessControl: AccessControlModule,
    private readonly repository: ScopedResourceRepository<TResource, TListQuery>,
    private readonly resource: ResourceDefinition,
    private readonly scopeStore: ResourceScopeStore,
    private readonly authorizedQuery = new AuthorizedResourceQuery(),
  ) {}

  protected async createAuthorized(
    actorId: string,
    createRecord: () => Omit<TResource, "id" | "scope" | "access">,
  ): Promise<TResource> {
    const actor = await this.accessControl.createActorContext({ actorId });
    const created = await this.repository.create(createRecord());
    try {
      await this.accessControl.initializeResourceAccess({ actor, resource: this.resource, resourceId: created.id });
      await this.accessControl.authorize({ actor, action: "create", resource: this.resource, resourceId: created.id });
      return this.withAccess(actor, await this.requireResource(created.id));
    } catch (error) {
      await this.repository.delete(created.id);
      throw error;
    }
  }

  protected async getAuthorized(actorId: string, resourceId: string): Promise<TResource> {
    return this.getAuthorizedResource(actorId, resourceId, "read");
  }

  protected async listAuthorized(actorId: string, query: TListQuery): Promise<ResourcePage<TResource>> {
    const actor = await this.accessControl.createActorContext({ actorId });
    const page = await this.authorizedQuery.list({
      repository: this.repository,
      query,
      access: this.accessControl.createListConstraint({ actor, resource: this.resource, action: "read" }),
    });
    return { ...page, items: await Promise.all(page.items.map((resource) => this.withAccess(actor, resource))) };
  }

  protected async updateAuthorized(
    actorId: string,
    resourceId: string,
    update: (resource: TResource) => TResource,
  ): Promise<TResource> {
    const resource = await this.getAuthorizedResource(actorId, resourceId, "update");
    const updated = await this.repository.replace(update(resource));
    const actor = await this.accessControl.createActorContext({ actorId });
    return this.withAccess(actor, updated);
  }

  protected async deleteAuthorized(actorId: string, resourceId: string): Promise<void> {
    const resource = await this.getAuthorizedResource(actorId, resourceId, "delete");
    await this.repository.delete(resource.id);
    await this.scopeStore.remove({ resourceType: this.resource.type, resourceId });
  }

  protected async updateScopeAuthorized(actorId: string, resourceId: string, scope: ResourceScope): Promise<TResource> {
    const actor = await this.accessControl.createActorContext({ actorId });
    await this.getAuthorizedResource(actorId, resourceId, "update");
    await this.scopeStore.update({ resourceType: this.resource.type, resourceId, scope });
    return this.withAccess(actor, await this.requireResource(resourceId));
  }

  protected async getAuthorizedResource(
    actorId: string,
    resourceId: string,
    action: ResourceAction,
  ): Promise<TResource> {
    const actor = await this.accessControl.createActorContext({ actorId });
    const resource = await this.authorizedQuery.findById({
      repository: this.repository,
      resourceId,
      access: this.accessControl.createListConstraint({ actor, resource: this.resource, action: "read" }),
    });
    if (!resource) throw new Error("未找到当前资源范围内的资源");
    await this.accessControl.authorize({ actor, action, resource: this.resource, resourceId });
    return this.withAccess(actor, resource);
  }

  private async withAccess(actor: ActorContext, resource: TResource): Promise<TResource> {
    return {
      ...resource,
      access: await this.accessControl.resolveAccess({ actor, resource: this.resource, resourceId: resource.id }),
    };
  }

  private async requireResource(resourceId: string): Promise<TResource> {
    const resource = await this.repository.findById(resourceId);
    if (!resource) throw new Error("资源创建后未找到资源主表记录");
    return resource;
  }
}
