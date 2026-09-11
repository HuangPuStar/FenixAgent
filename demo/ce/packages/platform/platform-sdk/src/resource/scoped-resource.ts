import type { ResourceQueryConstraint, ResourceScope } from "../index";

/** 所有可通过平台泛型 Facade 管理的资源至少拥有 ID 和授权模块写入的归属范围。 */
export interface ScopedResource {
  readonly id: string;
  readonly ownershipScope: ResourceScope;
}

/** 通用列表结果；各资源包可在此基础上构造资源特有 ViewModel。 */
export interface ResourcePage<TResource> {
  readonly items: readonly TResource[];
}

/** 资源持久化端口只负责数据库/存储操作，生产实现必须把查询约束转为 SQL WHERE。 */
export interface ScopedResourceRepository<TResource extends ScopedResource, TListQuery> {
  create(record: Omit<TResource, "id">): Promise<TResource>;
  findById(id: string, queryConstraint: ResourceQueryConstraint): Promise<TResource | undefined>;
  list(input: { queryConstraint: ResourceQueryConstraint; query: TListQuery }): Promise<ResourcePage<TResource>>;
  replace(resource: TResource): Promise<TResource>;
  delete(id: string): Promise<void>;
}
