import { describe, expect, test } from "bun:test";
import type { ActorContext, ResourceDefinition, ResourceScope } from "@fenix/platform-sdk";
import { pgTable, text } from "drizzle-orm/pg-core";
import { DefaultAccessControl } from "../index";
import { projectActions, resolveListPolicyFacts, resolvePolicyFacts } from "../policy/policy-facts";
import { buildAuthorizationPredicate } from "../query/build-predicate";
import { resolveScopeColumns } from "../scope/scope-columns";
import { rowSatisfiesPredicate } from "./predicate-evaluator";

/**
 * 授权一致性合同测试（设计 §3.3）。
 *
 * 列表谓词是动作推导在 SQL 中的等价重写，两者必须由同一份事实派生。这里穷举
 * `(actor, resource, scope)` 组合，对每个组合断言：
 *
 *   `rowSatisfiesPredicate(谓词, 行)` ⟺ `action ∈ projectActions(facts, scope)`
 *
 * 组合是确定性枚举而不是随机采样：边界（缺失 active organization、无成员关系、未声明
 * `visibility`、`publicDefaultActions` 为空、声明了资源未支持的动作）必须每次都覆盖到。
 */

const table = pgTable("consistency_resource", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id"),
  ownerUserId: text("user_id"),
  visibility: text("visibility"),
});

const columns = {
  id: table.id,
  organizationId: table.organizationId,
  ownerUserId: table.ownerUserId,
  visibility: table.visibility,
};

const OWNER_ACTOR: ActorContext = {
  kind: "user",
  userId: "u1",
  activeOrganizationId: "org-a",
  memberships: [{ organizationId: "org-a", role: "owner" }],
};
const OTHER_ORGANIZATION_ADMIN_ACTOR: ActorContext = {
  kind: "user",
  userId: "u1",
  activeOrganizationId: "org-a",
  memberships: [
    { organizationId: "org-a", role: "member" },
    { organizationId: "org-b", role: "admin" },
  ],
};
const MEMBER_ACTOR: ActorContext = {
  kind: "user",
  userId: "u1",
  activeOrganizationId: "org-a",
  memberships: [{ organizationId: "org-a", role: "member" }],
};
const UNRELATED_ACTOR: ActorContext = {
  kind: "user",
  userId: "u1",
  activeOrganizationId: "org-a",
  memberships: [{ organizationId: "org-c", role: "member" }],
};
const NO_MEMBERSHIP_ACTOR: ActorContext = {
  kind: "user",
  userId: "u1",
  activeOrganizationId: "org-a",
  memberships: [],
};
const NO_ACTIVE_ORGANIZATION_ACTOR: ActorContext = {
  kind: "user",
  userId: "u1",
  memberships: [{ organizationId: "org-a", role: "admin" }],
};
const SUPER_ADMIN_ACTOR: ActorContext = {
  kind: "user",
  userId: "u1",
  systemRole: "super-admin",
  memberships: [],
};

const ACTORS: readonly { readonly label: string; readonly actor: ActorContext }[] = [
  { label: "owner-of-active-org", actor: OWNER_ACTOR },
  { label: "admin-of-other-org", actor: OTHER_ORGANIZATION_ADMIN_ACTOR },
  { label: "member-only", actor: MEMBER_ACTOR },
  { label: "unrelated-member", actor: UNRELATED_ACTOR },
  { label: "no-membership", actor: NO_MEMBERSHIP_ACTOR },
  { label: "no-active-organization", actor: NO_ACTIVE_ORGANIZATION_ACTOR },
  { label: "super-admin", actor: SUPER_ADMIN_ACTOR },
];

const ALL_ACTIONS = ["read", "create", "update", "delete", "use"] as const;

const ORGANIZATION_RESOURCE: ResourceDefinition = {
  type: "consistency-resource",
  ownershipMode: "organization",
  actions: ALL_ACTIONS,
  memberDefaultActions: ["read", "use"],
  publicDefaultActions: ["read"],
};
const ORGANIZATION_PRIVATE_RESOURCE: ResourceDefinition = {
  ...ORGANIZATION_RESOURCE,
  publicDefaultActions: [],
};
const ORGANIZATION_PERSONAL_RESOURCE: ResourceDefinition = {
  ...ORGANIZATION_RESOURCE,
  ownershipMode: "organization-personal",
};
const PERSONAL_RESOURCE: ResourceDefinition = {
  ...ORGANIZATION_RESOURCE,
  ownershipMode: "personal",
};
/** 公开默认动作声明了资源未支持的动作：`resource.actions` 是上限，两个实现都必须忽略它。 */
const OVERREACHING_PUBLIC_RESOURCE: ResourceDefinition = {
  ...ORGANIZATION_RESOURCE,
  actions: ["read"],
  memberDefaultActions: ["read"],
  publicDefaultActions: ["use"],
};
/** 成员默认动作声明了资源未支持的动作：成员分支同样受上限约束，不能只过滤公开动作。 */
const OVERREACHING_MEMBER_RESOURCE: ResourceDefinition = {
  ...ORGANIZATION_RESOURCE,
  actions: ["read", "use"],
  memberDefaultActions: ["read", "delete"],
};

const RESOURCES: readonly ResourceDefinition[] = [
  ORGANIZATION_RESOURCE,
  ORGANIZATION_PRIVATE_RESOURCE,
  ORGANIZATION_PERSONAL_RESOURCE,
  PERSONAL_RESOURCE,
  OVERREACHING_PUBLIC_RESOURCE,
  OVERREACHING_MEMBER_RESOURCE,
];

const SCOPES: readonly ResourceScope[] = [
  { organizationId: "org-a", ownerUserId: "u1", visibility: "private" },
  { organizationId: "org-a", ownerUserId: "u2", visibility: "private" },
  { organizationId: "org-a", ownerUserId: "u1", visibility: "public" },
  { organizationId: "org-b", ownerUserId: "u1", visibility: "private" },
  { organizationId: "org-b", ownerUserId: "u1", visibility: "public" },
  { organizationId: "org-c", ownerUserId: "u2", visibility: "public" },
  { ownerUserId: "u1", visibility: "private" },
  { ownerUserId: "u1", visibility: "public" },
];

const ACTIONS = ["read", "use"] as const;

function rowOf(scope: ResourceScope): Record<string, unknown> {
  return {
    organization_id: scope.organizationId ?? null,
    user_id: scope.ownerUserId ?? null,
    visibility: scope.visibility,
  };
}

describe("authorization consistency", () => {
  // 穷举组合：谓词命中 ⟺ 动作集合包含该动作，两个实现不得漂移。
  test("list predicate is equivalent to projected actions", () => {
    let checked = 0;
    for (const { label, actor } of ACTORS) {
      for (const resource of RESOURCES) {
        const facts = resolvePolicyFacts({ actor, resource });
        for (const candidate of SCOPES) {
          const actions = projectActions(facts, candidate);
          for (const action of ACTIONS) {
            const predicate = buildAuthorizationPredicate(resolveListPolicyFacts({ actor, resource, action }), columns);
            const satisfied = rowSatisfiesPredicate(predicate, rowOf(candidate));
            if (satisfied !== actions.includes(action)) {
              throw new Error(
                `授权漂移：actor=${label} scope=${JSON.stringify(candidate)} action=${action} ` +
                  `谓词=${satisfied} 动作集合=${JSON.stringify(actions)}`,
              );
            }
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(ACTORS.length * RESOURCES.length * SCOPES.length * ACTIONS.length);
  });

  // 动作集合永远不超过 `resource.actions`：默认动作里声明了资源未支持的动作时，归属分支与公开分支
  // 都必须忽略它。漏掉这条约束会让动作推导比谓词更宽（详情放行、列表却查不到），两个形态就此分叉。
  test("projected actions never exceed the declared action set", () => {
    for (const { label, actor } of ACTORS) {
      for (const resource of RESOURCES) {
        const facts = resolvePolicyFacts({ actor, resource });
        for (const candidate of SCOPES) {
          const exceeding = projectActions(facts, candidate).filter((action) => !resource.actions.includes(action));
          if (exceeding.length > 0) {
            throw new Error(
              `动作超出资源声明：actor=${label} resource=${resource.type} scope=${JSON.stringify(candidate)} ` +
                `超出=${JSON.stringify(exceeding)}`,
            );
          }
        }
      }
    }
  });

  // 详情路径（resolveAccess）也必须得到同一份动作：列表与详情共用一个推导。
  test("detail access matches projected actions through the public module contract", async () => {
    const accessControl = new DefaultAccessControl({
      initialize: async () => undefined,
      getMany: async () => new Map(SCOPES.map((scope, index) => [`resource-${index}`, scope])),
      update: async () => undefined,
      remove: async () => undefined,
    });

    for (const { label, actor } of ACTORS) {
      for (const resource of RESOURCES) {
        for (const [index, candidate] of SCOPES.entries()) {
          const access = await accessControl.resolveAccess({ actor, resource, resourceId: `resource-${index}` });
          const expected = projectActions(resolvePolicyFacts({ actor, resource }), candidate);
          if (JSON.stringify([...access.actions].sort()) !== JSON.stringify([...expected].sort())) {
            throw new Error(
              `详情动作与推导不一致：actor=${label} scope=${JSON.stringify(candidate)} ` +
                `详情=${JSON.stringify(access.actions)} 推导=${JSON.stringify(expected)}`,
            );
          }
        }
      }
    }
  });

  // 三处都不成立时必须编译为恒假条件，绝不退化为"没有条件 = 放行全量"。
  test("compiles an always-false predicate when nothing grants access", () => {
    const predicate = buildAuthorizationPredicate(
      resolveListPolicyFacts({
        actor: NO_MEMBERSHIP_ACTOR,
        resource: ORGANIZATION_PRIVATE_RESOURCE,
        action: "read",
      }),
      { ...columns, visibility: undefined },
    );

    expect(predicate).toBeDefined();
    for (const candidate of SCOPES) {
      expect(rowSatisfiesPredicate(predicate, rowOf(candidate))).toBe(false);
    }
  });

  // 未声明 `visibility` 列的资源没有公开受众：谓词里不得出现公开分支。
  test("omits the public branch when the resource declares no visibility column", () => {
    const predicate = buildAuthorizationPredicate(
      resolveListPolicyFacts({ actor: MEMBER_ACTOR, resource: ORGANIZATION_RESOURCE, action: "read" }),
      { ...columns, visibility: undefined },
    );

    expect(predicate).toBeDefined();
    expect(rowSatisfiesPredicate(predicate, { organization_id: "org-z", user_id: "u9", visibility: "public" })).toBe(
      false,
    );
    expect(rowSatisfiesPredicate(predicate, { organization_id: "org-a", user_id: "u9", visibility: "public" })).toBe(
      true,
    );
  });

  // 归属列声明缺失属于注册错误：必须报错，不能静默生成放行谓词。
  test("fails loudly when the binding omits a required ownership column", () => {
    expect(() =>
      buildAuthorizationPredicate(
        resolveListPolicyFacts({ actor: MEMBER_ACTOR, resource: ORGANIZATION_RESOURCE, action: "read" }),
        { id: columns.id, visibility: columns.visibility },
      ),
    ).toThrow(/organizationId/);
  });

  // 列不属于主表时注册即失败，避免谓词作用在错误的表上。
  test("rejects columns that do not belong to the declared table", () => {
    expect(() =>
      resolveScopeColumns({
        resourceType: ORGANIZATION_RESOURCE.type,
        table,
        columns: { id: text("other_id") },
      }),
    ).toThrow(/id 列不属于其主表/);
  });
});
