import {
  type AccessControlModule,
  type ActorContext,
  type AuthorizationInput,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourceAccess,
  ResourceAccessDeniedError,
  type ResourceAction,
  type ResourceDefinition,
  type ResourceQueryConstraint,
  type ResourceScope,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { projectActions, resolveListPolicyFacts, resolvePolicyFacts } from "./policy/policy-facts";

/**
 * 条件句柄的产出者标识。
 *
 * 不透明条件只能由产出它的实现编译：查询实现校验 `provider` 一致，跨实现（例如 EE 的授权实现）
 * 的句柄不会被 CE 的谓词编译器"尽力解释"成放行条件。
 */
export const ACCESS_CONTROL_PROVIDER = "access-control";

export interface DefaultAccessControlOptions {
  /**
   * 归属范围的读写入口。
   *
   * CE 注入 `ColumnResourceScopeStore`（主表归属列）；EE 可替换为 side-table 实现，本类的策略
   * 与动作推导不随之改变。
   */
  readonly scopeStore: ResourceScopeStore;
}

/**
 * 默认（CE）授权实现。
 *
 * 它只做两件事：读取资源的归属范围，用 {@link projectActions} 推导有效动作。谓词与动作推导共用
 * 同一份事实，因此列表、详情与变更三处不会出现规则漂移（设计 §3.5）。它不产出也不解释 SQL——
 * SQL 由查询实现（`DrizzleAuthorizedResourceQuery`）编译。
 */
export class DefaultAccessControl implements AccessControlModule {
  readonly id = ACCESS_CONTROL_PROVIDER;

  constructor(private readonly scopeStore: ResourceScopeStore) {}

  /**
   * 创建期的初始归属：归属列是主表的 `NOT NULL` 列，必须在 INSERT 前解析并与行一同写入。
   *
   * 组织资源不记 owner——归属属于组织，记 owner 会让它看起来像个人资源；组织内个人资源与纯
   * 个人资源都归创建者。
   *
   * 本方法同时判定 `create`：创建期没有 resourceId，`authorize` 无从校验，若这里不判定，任何
   * 组织成员都能创建组织资源（与成员动作收敛到 `memberDefaultActions` 的设计相矛盾）。判定用的是
   * 与 `authorize` 相同的 {@link projectActions}，作用于即将写入的归属范围，因此"谁能创建"与
   * "谁能修改"永远同源。拒绝抛 {@link ResourceAccessDeniedError}，由 Facade 映射为对外 403。
   */
  async resolveInitialScope(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    organizationId?: string;
  }): Promise<ResourceScope> {
    const scope = this.initialScope(input);
    if (!this.project(input, scope).includes("create")) {
      throw new ResourceAccessDeniedError("当前主体无权创建该资源");
    }
    return scope;
  }

  private initialScope(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    organizationId?: string;
  }): ResourceScope {
    if (input.resource.ownershipMode === "personal") {
      return { ownerUserId: input.actor.userId, visibility: "private" };
    }
    // 显式指定的目标组织只由系统管理 Facade 传入；普通主体的归属由其 active organization 决定。
    const organizationId = input.organizationId ?? input.actor.activeOrganizationId;
    if (organizationId === undefined) throw new Error("资源创建需要目标组织上下文");
    if (input.resource.ownershipMode === "organization-personal") {
      return { organizationId, ownerUserId: input.actor.userId, visibility: "private" };
    }
    return { organizationId, visibility: "private" };
  }

  /**
   * side-table 型范围的独立初始化路径（EE）。
   *
   * CE 的 `ColumnResourceScopeStore.initialize` 直接报错：归属列随资源行写入，不存在"先建行
   * 再初始化范围"的窗口；EE 替换 scopeStore 后本方法即生效。
   */
  async initializeResourceAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void> {
    await this.scopeStore.initialize({
      resourceType: input.resource.type,
      resourceId: input.resourceId,
      scope: await this.resolveInitialScope(input),
    });
  }

  async authorize(input: AuthorizationInput): Promise<void> {
    const scope = await this.getScope(input.resource, input.resourceId);
    if (!this.project(input, scope).includes(input.action)) {
      throw new ResourceAccessDeniedError();
    }
  }

  /** 产出不透明条件：载荷是已解析的授权事实，只有本包的谓词编译器能读。 */
  async createListConstraint(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    action: "read" | "use";
  }): Promise<ResourceQueryConstraint> {
    return {
      resourceType: input.resource.type,
      action: input.action,
      provider: this.id,
      [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: resolveListPolicyFacts(input),
    };
  }

  async resolveAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<ResourceAccess> {
    return { actions: this.project(input, await this.getScope(input.resource, input.resourceId)) };
  }

  /**
   * 列表批量版本。
   *
   * 与单资源版本共用同一份推导；范围缺失（例如列表查询之后资源被并发删除）时跳过该行：让整批
   * 读取因一行消失而失败，代价高于让调用方拿到"这一行没有 access"。
   */
  async resolveAccessMany(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceIds: readonly string[];
  }): Promise<ReadonlyMap<string, ResourceAccess>> {
    const scopes = await this.scopeStore.getMany({
      resourceType: input.resource.type,
      resourceIds: input.resourceIds,
    });
    const result = new Map<string, ResourceAccess>();
    for (const [resourceId, scope] of scopes) {
      result.set(resourceId, { actions: this.project(input, scope) });
    }
    return result;
  }

  private project(
    input: { actor: ActorContext; resource: ResourceDefinition },
    scope: ResourceScope,
  ): readonly ResourceAction[] {
    return projectActions(resolvePolicyFacts(input), scope);
  }

  private async getScope(resource: ResourceDefinition, resourceId: string): Promise<ResourceScope> {
    const scope = (await this.scopeStore.getMany({ resourceType: resource.type, resourceIds: [resourceId] })).get(
      resourceId,
    );
    if (!scope) throw new Error("资源缺少归属范围");
    return scope;
  }
}

export function createDefaultAccessControl(options: DefaultAccessControlOptions): DefaultAccessControl {
  return new DefaultAccessControl(options.scopeStore);
}
