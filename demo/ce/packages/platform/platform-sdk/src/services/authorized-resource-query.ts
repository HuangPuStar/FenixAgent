import type { ResourceQueryConstraint } from "../index";
import type { ResourcePage, ScopedResource, ScopedResourceRepository } from "../resource/scoped-resource";

/** demo 内部的已编译条件；真实实现以 Drizzle SQL 条件替代此谓词。 */
type CompiledResourceQueryConstraint = ResourceQueryConstraint & {
  matches(scope: ScopedResource["scope"]): boolean;
};

/**
 * 平台拥有的授权查询边界。
 *
 * 资源 repository 不解析 access；生产实现应在此处将 access 与资源主表列编译到同一条 SQL，
 * 由数据库完成过滤、排序和分页。内存 demo 用谓词模拟该编译结果。
 */
export class AuthorizedResourceQuery {
  async findById<TResource extends ScopedResource, TListQuery>(input: {
    repository: ScopedResourceRepository<TResource, TListQuery>;
    resourceId: string;
    access: ResourceQueryConstraint;
  }): Promise<TResource | undefined> {
    const resource = await input.repository.findById(input.resourceId);
    return resource && this.compile(input.access).matches(resource.scope) ? resource : undefined;
  }

  async list<TResource extends ScopedResource, TListQuery>(input: {
    repository: ScopedResourceRepository<TResource, TListQuery>;
    query: TListQuery;
    access: ResourceQueryConstraint;
  }): Promise<ResourcePage<TResource>> {
    const page = await input.repository.list(input.query);
    const limit = this.limitOf(input.query);
    return {
      ...page,
      items: page.items.filter((resource) => this.compile(input.access).matches(resource.scope)).slice(0, limit),
    };
  }

  private compile(access: ResourceQueryConstraint): CompiledResourceQueryConstraint {
    const compiled = access as Partial<CompiledResourceQueryConstraint>;
    if (typeof compiled.matches !== "function") throw new Error("AccessControl 未提供可编译的资源查询条件");
    return compiled as CompiledResourceQueryConstraint;
  }

  private limitOf(query: unknown): number {
    if (typeof query !== "object" || !query || !("limit" in query) || typeof query.limit !== "number") return 100;
    return Math.min(query.limit, 100);
  }
}
