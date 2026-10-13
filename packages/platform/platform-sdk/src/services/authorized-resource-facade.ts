import type {
  AccessControlModule,
  ActorContext,
  ResourceAccess,
  ResourceAction,
  ResourceDefinition,
  ResourceQueryConstraint,
  ResourceScope,
  ResourceScopeStore,
  ResourceVisibility,
} from "../resource/authorization";

/** Facade 输入：已带归属范围的资源行，由授权查询或 Domain Service 产出。 */
export type ScopedResourceInput = { readonly id: string; readonly scope: ResourceScope };

/** 带当前 actor 有效动作的资源记录。 */
export type AuthorizedResource<TResource> = TResource & { readonly access: ResourceAccess };

/** 资源 Facade 的装配依赖；`accessControl` 与 `scopeStore` 由宿主注入同一实现。 */
export interface AuthorizedResourceFacadeOptions {
  readonly accessControl: AccessControlModule;
  readonly resource: ResourceDefinition;
  readonly scopeStore: ResourceScopeStore;
}

/**
 * 资源 Facade 的授权编排基类。
 *
 * 资源包的 Facade 继承本类，只负责「授权 + 状态校验 + 跨资源编排」，数据读取交给自己的
 * Domain Service（无 actor、无权限判断）：`route → Facade → Domain Service → Repository`。
 * 授权规则与列表条件都经 `AccessControlModule` 产出，Facade 不复制任何组织、角色或
 * `visibility` 判断，也不接触资源主表的归属列。
 */
export abstract class AuthorizedResourceFacade {
  constructor(protected readonly options: AuthorizedResourceFacadeOptions) {}

  /**
   * 创建期初始归属。
   *
   * 归属列在资源主表且为 `NOT NULL`，因此取值必须与资源行同一条 INSERT 写入；Facade 把它交给
   * Domain Service 的创建方法，而不是先建行再补写。
   */
  protected async resolveInitialScope(actor: ActorContext, organizationId?: string): Promise<ResourceScope> {
    return this.options.accessControl.resolveInitialScope({
      actor,
      resource: this.options.resource,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
  }

  /**
   * 列表授权条件；必须传给 Domain Service 的 list，漏传会让查询退化为无权限过滤。
   * 条件是不透明句柄，Facade 不得解析。
   */
  protected async listConstraint(
    actor: ActorContext,
    action: "read" | "use" = "read",
  ): Promise<ResourceQueryConstraint> {
    return this.options.accessControl.createListConstraint({ actor, action, resource: this.options.resource });
  }

  /** 单资源动作校验；详情、修改、删除、运行都必须先走这里。 */
  protected async authorizeAction(actor: ActorContext, action: ResourceAction, resourceId: string): Promise<void> {
    await this.options.accessControl.authorize({
      actor,
      action,
      resource: this.options.resource,
      resourceId,
    });
  }

  /** 为单条资源补齐 `access`。 */
  protected async withAccess<TResource extends ScopedResourceInput>(
    actor: ActorContext,
    resource: TResource,
  ): Promise<AuthorizedResource<TResource>> {
    const access = await this.options.accessControl.resolveAccess({
      actor,
      resource: this.options.resource,
      resourceId: resource.id,
    });
    return { ...resource, access };
  }

  /** 为一批资源补齐 `access`（一次批量查询，不做逐行 N+1）。 */
  protected async withAccessMany<TResource extends ScopedResourceInput>(
    actor: ActorContext,
    resources: readonly TResource[],
  ): Promise<AuthorizedResource<TResource>[]> {
    if (resources.length === 0) return [];
    const accessById = await this.options.accessControl.resolveAccessMany({
      actor,
      resource: this.options.resource,
      resourceIds: resources.map((resource) => resource.id),
    });
    return resources.map((resource) => {
      const access = accessById.get(resource.id);
      // 列出的资源必然有归属范围（授权谓词就是从归属列推导的），缺项说明查询与范围读取不一致。
      if (!access) throw new Error(`资源 ${resource.id} 缺少授权结果`);
      return { ...resource, access };
    });
  }

  /**
   * 更新资源的公开受众。
   *
   * `visibility` 只由已获资源管理权限的 Facade 更新；归属列（组织、owner）不在此路径上，
   * 它们在创建期写入并在资源生命周期内不变。
   */
  protected async setVisibility(
    actor: ActorContext,
    resourceId: string,
    visibility: ResourceVisibility,
  ): Promise<void> {
    await this.authorizeAction(actor, "update", resourceId);
    const scope = (
      await this.options.scopeStore.getMany({
        resourceType: this.options.resource.type,
        resourceIds: [resourceId],
      })
    ).get(resourceId);
    if (!scope) throw new Error("资源缺少归属范围");
    await this.options.scopeStore.update({
      resourceType: this.options.resource.type,
      resourceId,
      scope: { ...scope, visibility },
    });
  }
}
