import type { ResourceQueryConstraint } from "../index";
import type { ResourcePage, ScopedResource, ScopedResourceRepository } from "../resource/scoped-resource";

/**
 * 统一授权查询的资源端口。
 *
 * 平台实现只负责把不透明约束传给存储 adapter；repository 不得拆解 actor、role 或
 * visibility。当前 CE 仍允许资源 repository 自己接收该约束，后续 Drizzle adapter
 * 在这里替换，不改变资源 Facade 契约。
 */
export class AuthorizedResourceQuery {
  async findById<TResource extends ScopedResource>(input: {
    repository: Pick<ScopedResourceRepository<TResource, never>, "findById">;
    resourceId: string;
    access: ResourceQueryConstraint;
  }): Promise<TResource | undefined> {
    return input.repository.findById(input.resourceId, input.access);
  }

  async list<TResource extends ScopedResource, TListQuery>(input: {
    repository: ScopedResourceRepository<TResource, TListQuery>;
    query: TListQuery;
    access: ResourceQueryConstraint;
  }): Promise<ResourcePage<TResource>> {
    return input.repository.list(input.query, input.access);
  }
}
