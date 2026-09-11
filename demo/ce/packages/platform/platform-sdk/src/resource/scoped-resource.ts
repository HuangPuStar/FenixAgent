import type { ResourceAccess, ResourceScope } from "../index";

/** 所有可通过平台泛型 Facade 管理的资源至少拥有 ID 和授权模块写入的归属范围。 */
export interface ScopedResource {
  readonly id: string;
  readonly scope: ResourceScope;
  readonly access: ResourceAccess;
}

/** 通用列表结果；各资源包可在此基础上构造资源特有 ViewModel。 */
export interface ResourcePage<TResource> {
  readonly items: readonly TResource[];
}

/** 资源持久化端口只负责数据库/存储操作，不解释成员、角色或 visibility。 */
export interface ScopedResourceRepository<TResource extends ScopedResource, TListQuery> {
  create(record: Omit<TResource, "id" | "scope" | "access">): Promise<TResource>;
  findById(id: string): Promise<TResource | undefined>;
  list(query: TListQuery): Promise<ResourcePage<TResource>>;
  replace(resource: TResource): Promise<TResource>;
  delete(id: string): Promise<void>;
}
