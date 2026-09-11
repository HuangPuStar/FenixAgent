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

/**
 * 有权限控制的资源应用层 Facade。
 *
 * 它统一认证上下文、资源查询约束与 CRUD 授权；不承载资源字段校验、状态机或持久化细节。
 */
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
      await this.authorize(actor, "create", created.id);
      return this.withAccess(actor, await this.requireResource(created.id));
    } catch (error) {
      // 生产实现须将创建、Scope Store 初始化与 create 授权置于同一事务；demo 显式回滚内存行。
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
  }

  /** 归属与 visibility 必须经同一个 ResourceScopeStore 写入资源主表固定列。 */
  protected async updateScopeAuthorized(actorId: string, resourceId: string, scope: ResourceScope): Promise<TResource> {
    const actor = await this.accessControl.createActorContext({ actorId });
    await this.getAuthorizedResource(actorId, resourceId, "update");
    await this.scopeStore.update({ resourceType: this.resource.type, resourceId, scope });
    return this.withAccess(actor, await this.requireResource(resourceId));
  }

  /** 供 EE Facade 等应用层扩展复用，始终保持资源查询约束与授权检查。 */
  protected async getAuthorizedResource(
    actorId: string,
    resourceId: string,
    action: ResourceAction,
  ): Promise<TResource> {
    const actor = await this.accessControl.createActorContext({ actorId });
    const resource = await this.findInAccessibleScope(resourceId, actor);
    await this.authorize(actor, action, resource.id);
    return this.withAccess(actor, resource);
  }

  private async authorize(actor: ActorContext, action: ResourceAction, resourceId: string): Promise<void> {
    await this.accessControl.authorize({
      actor,
      action,
      resource: this.resource,
      resourceId,
    });
  }

  private async findInAccessibleScope(resourceId: string, actor: ActorContext): Promise<TResource> {
    const resource = await this.authorizedQuery.findById({
      repository: this.repository,
      resourceId,
      access: this.accessControl.createListConstraint({ actor, resource: this.resource, action: "read" }),
    });
    if (!resource) {
      throw new Error("未找到当前资源范围内的资源");
    }
    return resource;
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
