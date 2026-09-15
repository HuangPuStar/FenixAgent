import type { ResourceAccess, ResourceQueryConstraint, ResourceScope } from "../index";

/** 所有受控资源至少需要稳定 ID；scope/access 由平台边界补齐。 */
export interface ScopedResource {
  readonly id: string;
  readonly scope: ResourceScope;
  readonly access: ResourceAccess;
}

/** 资源 repository 的分页结果；授权过滤必须在 repository 查询阶段完成。 */
export interface ResourcePage<TResource> {
  readonly items: readonly TResource[];
  readonly total?: number;
}

/**
 * 资源持久化端口只表达存储操作，不接受 actor、成员或角色；access 是不透明条件。
 * 具体 Drizzle 编译由平台 AuthorizedResourceQuery 适配器负责。
 */
export interface ScopedResourceRepository<TResource extends ScopedResource, TListQuery> {
  create(record: Omit<TResource, "id" | "scope" | "access">): Promise<TResource>;
  findById(id: string, access?: ResourceQueryConstraint): Promise<TResource | undefined>;
  list(query: TListQuery, access?: ResourceQueryConstraint): Promise<ResourcePage<TResource>>;
  replace(resource: TResource): Promise<TResource>;
  delete(id: string): Promise<void>;
}
