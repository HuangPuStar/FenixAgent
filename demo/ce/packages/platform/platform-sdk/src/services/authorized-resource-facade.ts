import type { AccessControlModule, ResourceContext, ResourceScope } from "../index";
import type { ResourcePage, ScopedResource, ScopedResourceRepository } from "../resource/scoped-resource";

/**
 * 有权限控制的资源应用层 Facade。
 *
 * 它统一认证上下文、资源查询约束与 CRUD 授权；不承载资源字段校验、状态机或持久化细节。
 */
export class AuthorizedResourceFacade<TResource extends ScopedResource, TListQuery> {
  constructor(
    protected readonly accessControl: AccessControlModule,
    private readonly repository: ScopedResourceRepository<TResource, TListQuery>,
    private readonly resourceActionPrefix: string,
  ) {}

  protected async createAuthorized(
    actorId: string,
    createRecord: (ownershipScope: ResourceScope) => Omit<TResource, "id">,
  ): Promise<TResource> {
    const context = await this.accessControl.createResourceContext({ actorId });
    await this.authorize(actorId, "write", context.scope);
    return this.repository.create(createRecord(context.scope));
  }

  protected async getAuthorized(actorId: string, resourceId: string): Promise<TResource> {
    return this.getAuthorizedResource(actorId, resourceId, "read");
  }

  protected async listAuthorized(actorId: string, query: TListQuery): Promise<ResourcePage<TResource>> {
    const context = await this.accessControl.createResourceContext({ actorId });
    await this.authorize(actorId, "list", context.scope);
    return this.repository.list({ queryConstraint: this.accessControl.buildResourceQueryConstraint(context), query });
  }

  protected async updateAuthorized(
    actorId: string,
    resourceId: string,
    update: (resource: TResource) => TResource,
  ): Promise<TResource> {
    const resource = await this.getAuthorizedResource(actorId, resourceId, "write");
    return this.repository.replace(update(resource));
  }

  protected async deleteAuthorized(actorId: string, resourceId: string): Promise<void> {
    const resource = await this.getAuthorizedResource(actorId, resourceId, "write");
    this.repository.delete(resource.id);
  }

  /** 供 EE Facade 等应用层扩展复用，始终保持资源查询约束与授权检查。 */
  protected async getAuthorizedResource(actorId: string, resourceId: string, action: string): Promise<TResource> {
    const context = await this.accessControl.createResourceContext({ actorId });
    const resource = this.findInAccessibleScope(resourceId, context);
    await this.authorize(actorId, action, resource.ownershipScope);
    return resource;
  }

  private async authorize(actorId: string, action: string, resourceScope: ResourceScope): Promise<void> {
    await this.accessControl.authorize({
      actorId,
      action: `${this.resourceActionPrefix}:${action}`,
      resourceScope,
    });
  }

  private findInAccessibleScope(resourceId: string, context: ResourceContext): TResource {
    const resource = this.repository.findById(resourceId, this.accessControl.buildResourceQueryConstraint(context));
    if (!resource) {
      throw new Error("未找到当前资源范围内的资源");
    }
    return resource;
  }
}
