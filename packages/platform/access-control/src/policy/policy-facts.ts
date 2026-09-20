import type { ActorContext, ResourceAction, ResourceDefinition, ResourceScope } from "@fenix/platform-sdk";

/**
 * 授权策略的唯一实现。
 *
 * 列表谓词与动作推导必须由同一份规则派生：两者都从 {@link PolicyFacts} 读出 actor 与资源声明
 * 中的有效关系，谓词只是它在 SQL 中的等价重写。因此本模块不导出"另一个"动作推导入口，
 * `authorize`、`resolveAccess*` 与谓词编译器共用 {@link projectActions}。
 */

/** 列表查询只覆盖 `read` / `use`：写动作没有集合语义。 */
export type ListAction = "read" | "use";

/** actor 在某个组织里的成员角色（与 `ActorContext.memberships` 的元素同形）。 */
export type MembershipRole = ActorContext["memberships"][number]["role"];

/**
 * 已解析的归属关系事实：只描述 actor 与资源声明之间的关系，不含"要做什么"。
 *
 * **组织口径是当前 active organization**：组织资源的可见范围就是"当前组织内的资源"，actor 作为
 * 成员的其他组织一行都不可见。跨组织共享只能由 `visibility = public` 表达（设计 §5、§3.3），
 * 因此这里只保留"当前组织 + 我在其中的角色"，不保留其他组织的 id——保留它们会让谓词与动作推导
 * 都变成"我是成员的全部组织"的并集，等于把别的组织的私有资源混进当前组织的列表。
 */
export interface PolicyFacts {
  readonly resource: ResourceDefinition;
  readonly actorUserId: string;
  readonly actorActiveOrganizationId?: string;
  /**
   * actor 在 {@link actorActiveOrganizationId} 里的角色。
   *
   * 当前组织不在成员关系里（没有组织上下文，或成员关系已被移除）时为 `undefined`：此时组织分支
   * 整体不成立，资源只剩公开受众这一条路径。
   */
  readonly activeOrganizationRole?: MembershipRole;
  /** `systemRole === "super-admin"`：跳过归属与公开判定。 */
  readonly bypass: boolean;
}

/** 归属关系 + 本次列表查询要执行的动作，供谓词编译器使用。 */
export interface ListPolicyFacts extends PolicyFacts {
  readonly action: ListAction;
}

/** 解析归属关系事实；这是谓词与动作推导共同的上游。 */
export function resolvePolicyFacts(input: {
  readonly actor: ActorContext;
  readonly resource: ResourceDefinition;
}): PolicyFacts {
  const activeOrganizationId = input.actor.activeOrganizationId;
  // 只取当前组织那一条成员关系：组织口径由 active organization 决定，其他组织的角色不参与判定。
  const membership =
    activeOrganizationId === undefined
      ? undefined
      : input.actor.memberships.find((item) => item.organizationId === activeOrganizationId);
  return {
    resource: input.resource,
    actorUserId: input.actor.userId,
    ...(activeOrganizationId === undefined ? {} : { actorActiveOrganizationId: activeOrganizationId }),
    ...(membership === undefined ? {} : { activeOrganizationRole: membership.role }),
    bypass: input.actor.systemRole === "super-admin",
  };
}

/** 解析列表查询的完整事实。 */
export function resolveListPolicyFacts(input: {
  readonly actor: ActorContext;
  readonly resource: ResourceDefinition;
  readonly action: ListAction;
}): ListPolicyFacts {
  return { ...resolvePolicyFacts(input), action: input.action };
}

/** 本次查询的动作是否包含在成员的默认动作内。 */
export function memberAllowsAction(facts: ListPolicyFacts): boolean {
  return facts.resource.memberDefaultActions.includes(facts.action);
}

/** 本次查询的动作是否包含在公开默认动作内。 */
export function publicAllowsAction(facts: ListPolicyFacts): boolean {
  return facts.resource.publicDefaultActions.includes(facts.action);
}

/**
 * 推导 actor 对某个归属范围的有效动作。
 *
 * 规则（设计 §5）：super-admin 全量；纯个人资源归 owner；组织内个人资源要求当前组织上下文与
 * owner 同时匹配；组织资源要求归属组织就是当前组织，再按 actor 在该组织里的角色给全量或
 * `memberDefaultActions`；`visibility` 为 `public` 时在**原有归属规则之外**叠加
 * `publicDefaultActions`。三者都不成立时得到空集合——空集合由谓词编译器翻译为恒假条件，绝不放行全量。
 *
 * 「同组织」= 资源归属组织**就是 actor 的当前 active organization**：`organizationId` 相同的
 * 另一个组织（actor 是它的成员但不是当前组织）不构成归属，它在列表、详情、写路径上一律不可见。
 * 一个属于多个组织的用户通过切换组织访问各自的资源，跨组织共享由 `visibility = public` 表达，
 * 而不是由成员关系表达。这与列表谓词完全一致（谓词只匹配 `actorActiveOrganizationId` 这一个组织）。
 *
 * active organization 同时决定组织资源的归属与组织内个人资源的隔离范围。
 *
 * `resource.actions` 是动作集合的上限：`memberDefaultActions` / `publicDefaultActions` 若声明了
 * 资源未支持的动作，该动作不会因归属关系而凭空出现。
 */
export function projectActions(facts: PolicyFacts, scope: ResourceScope): readonly ResourceAction[] {
  const { resource } = facts;
  const organizationId = scope.organizationId;

  let actions: ResourceAction[] = [];
  if (facts.bypass) {
    actions = [...resource.actions];
  } else if (resource.ownershipMode === "personal" && scope.ownerUserId === facts.actorUserId) {
    actions = [...resource.actions];
  } else if (resource.ownershipMode === "organization-personal") {
    if (
      organizationId !== undefined &&
      organizationId === facts.actorActiveOrganizationId &&
      scope.ownerUserId === facts.actorUserId
    ) {
      actions = [...resource.actions];
    }
  } else if (resource.ownershipMode === "organization") {
    if (organizationId !== undefined && organizationId === facts.actorActiveOrganizationId) {
      if (facts.activeOrganizationRole === "owner" || facts.activeOrganizationRole === "admin") {
        actions = [...resource.actions];
      } else if (facts.activeOrganizationRole === "member") {
        // 与公开动作一样受 `resource.actions` 上限约束：声明了资源未支持的动作时两条路径必须同样忽略它，
        // 否则谓词（入口对未声明动作返回恒假）会比动作推导更窄，列表与详情就此分叉。
        actions = resource.memberDefaultActions.filter((action) => resource.actions.includes(action));
      }
    }
  }

  if (scope.visibility === "public" && resource.publicDefaultActions.length > 0) {
    // 成员动作与公开动作取并集：公开在原有归属规则之外扩大受众，不替换归属规则。
    const granted = new Set<ResourceAction>(actions);
    for (const action of resource.publicDefaultActions) {
      if (resource.actions.includes(action)) granted.add(action);
    }
    actions = [...granted];
  }
  return actions;
}
