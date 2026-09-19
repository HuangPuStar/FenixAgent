import type { ResourceScopeColumns } from "@fenix/platform-sdk";
import { and, eq, or, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { type ListPolicyFacts, memberAllowsAction, publicAllowsAction } from "../policy/policy-facts";

/**
 * 授权谓词编译器：把 {@link ListPolicyFacts} 翻译成 SQL 条件。
 *
 * 它是 `projectActions` 的等价重写，分支结构一一对应：
 *
 * ```sql
 * -- ownershipMode = "organization"、action = "read"
 * (
 *   r.organization_id = :activeOrgId                                 -- 归属组织就是当前组织
 *   AND (:roleAllows)                                                -- owner/admin 全量，member 看 memberDefaultActions
 *   OR (r.visibility = 'public' AND :publicAllows)                   -- 任意已认证用户 → 公开默认动作
 * )
 * ```
 *
 * 组织分支只匹配**一个**组织（actor 的当前 active organization）：actor 作为成员的其他组织的资源
 * 不进入结果集，跨组织共享只能由 `visibility = 'public'` 表达。用 `inArray` 匹配"我是成员的全部
 * 组织"会把别的组织的私有资源混进当前组织的列表。
 *
 * 契约类型把列声明为 `unknown`（`platform-sdk` 不导入 Drizzle），实现内部收窄为列类型；
 * 这是唯一需要知道"列是 Drizzle 列"的地方。
 */
export function buildAuthorizationPredicate<TColumn>(
  facts: ListPolicyFacts,
  columns: ResourceScopeColumns<TColumn>,
): SQL | undefined {
  // 资源未声明的动作对任何人都不成立（`projectActions` 以 `resource.actions` 为上限）；
  // 放在 bypass 之前，保证 super-admin 分支与动作推导同样受限。
  if (!facts.resource.actions.includes(facts.action)) return sql`false`;
  // super-admin 跳过归属与公开判定；其余分支必须是白名单，绝不退化为恒真。
  if (facts.bypass) return;

  const branches: SQL[] = [];
  const { resource } = facts;

  if (resource.ownershipMode === "organization") {
    const organizationColumn = requireColumn(columns.organizationId, resource.type, "organizationId");
    const activeOrganizationId = facts.actorActiveOrganizationId;
    // 当前组织里没有任何角色（无组织上下文或成员关系已失效）时组织分支整体不成立：
    // 此时资源只剩公开受众这一条路径，与 `projectActions` 的空动作集合一致。
    const grantsOrganizationResources =
      facts.activeOrganizationRole === "owner" ||
      facts.activeOrganizationRole === "admin" ||
      (facts.activeOrganizationRole === "member" && memberAllowsAction(facts));
    if (activeOrganizationId !== undefined && grantsOrganizationResources) {
      branches.push(eq(organizationColumn, activeOrganizationId));
    }
  } else if (resource.ownershipMode === "organization-personal") {
    // 组织内个人资源不因成员或管理身份获得默认动作（设计 §5.5），离开当前组织后隔离：
    // 只有「当前组织 + owner 本人」命中。
    const ownerInActiveOrganization =
      facts.actorActiveOrganizationId === undefined
        ? undefined
        : and(
            eq(requireColumn(columns.organizationId, resource.type, "organizationId"), facts.actorActiveOrganizationId),
            eq(requireColumn(columns.ownerUserId, resource.type, "ownerUserId"), facts.actorUserId),
          );
    if (ownerInActiveOrganization) branches.push(ownerInActiveOrganization);
  } else {
    branches.push(eq(requireColumn(columns.ownerUserId, resource.type, "ownerUserId"), facts.actorUserId));
  }

  // 未声明 visibility 列的资源没有公开受众：不加分支即可，它是合法声明而不是配置错误。
  if (publicAllowsAction(facts) && columns.visibility !== undefined) {
    branches.push(eq(columns.visibility as PgColumn, "public"));
  }

  if (branches.length === 0) return sql`false`;
  return or(...branches) ?? sql`false`;
}

/** 声明的归属列必须真实存在；缺失说明资源注册有误，静默降级会放宽授权范围。 */
function requireColumn<TColumn>(column: TColumn | undefined, resourceType: string, name: string): PgColumn {
  if (column === undefined) {
    throw new Error(`资源 ${resourceType} 的存储绑定缺少 ${name} 列`);
  }
  return column as PgColumn;
}
