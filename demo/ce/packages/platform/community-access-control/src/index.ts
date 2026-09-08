import type { AccessControlModule, AuthorizationInput, ResourceContext, ResourceScope } from "@fenix-ce/platform-sdk";

const OPEN_SOURCE_ORGANIZATION: ResourceScope = {
  kind: "organization",
  id: "org-open-source",
};

/**
 * CE 默认的用户—组织—角色授权实现。
 *
 * 真实实现可在此对接成员关系与角色表；资源包只依赖 AccessControlModule，不依赖其内部模型。
 */
export class CommunityAccessControl implements AccessControlModule {
  readonly id = "ce-access-control";

  async createResourceContext({ actorId }: { actorId: string }): Promise<ResourceContext> {
    return {
      subject: { id: actorId, type: "user" },
      scope: OPEN_SOURCE_ORGANIZATION,
    };
  }

  buildResourceQueryConstraint(context: ResourceContext) {
    return {
      matches: (scope: ResourceScope) => scope.kind === context.scope.kind && scope.id === context.scope.id,
    };
  }

  async authorize({ resourceScope }: AuthorizationInput): Promise<void> {
    if (resourceScope.id !== OPEN_SOURCE_ORGANIZATION.id) {
      throw new Error("CE: 当前组织无权访问此资源");
    }
  }
}
