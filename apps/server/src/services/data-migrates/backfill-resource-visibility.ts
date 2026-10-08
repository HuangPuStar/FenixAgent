import { agentConfig } from "@fenix/agent-config/db";
import { provider } from "@fenix/model-management/db";
import type { DataMigration, DataMigrationContext } from "@fenix/platform-sdk";
import { mcpServer } from "@fenix/resource-mcp/db";
import { skill } from "@fenix/resource-skill/db";
import { and, count, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import { resourcePermission } from "../../db/schema";

/**
 * 把旧 `resource_permission` 的"公开读"授权回填到资源主表的 `visibility` 列。
 *
 * 归属：本迁移**不能**落任何 owner 包的 `db/data-migrations/`（§6.3 的常规落点是那里），因此留在宿主。
 * 两条约束同时成立，且没有任何一个包能同时满足：
 * 1. 它必须读旧授权栈的 `resource_permission` 表——该表定义在宿主 `apps/server/src/db/schema.ts`，
 *    是经裁定暂留的宿主表。包不得依赖 `apps/**`（`apps-boundary`），因此没有 owner 包能拿到这张表。
 * 2. 它按资源 id 写 4 张别包 owner 的主表（agent_config / skill / mcp_server / provider）。把回填拆成
 *    4 个包内迁移确实能消除跨包写，但会改动发布契约：迁移 ID 已落 `data_migrate_record`，拆分即改名，
 *    runner 会判为未应用而重跑（§6.3「已应用的迁移不改名」）；且 4 份回填各自校验会失去「四张表同批
 *    收敛完成」这一整体判据。
 * 迁移 ID 的模块前缀 `access-control/` 指的是发起变更的授权栈（CE 阶段 2 任务 1.2），而 access-control
 * 是 platform 层实现，按依赖矩阵不得依赖任何资源包、也不持有业务表，同样放不下这份代码。
 * 因此本文件按「无单包可合法持有」保留在宿主，直到 `resource_permission` 被 DROP。
 *
 * 背景：旧授权栈用 `resource_permission` 中 `principal_type='all' AND action='read'` 表达"任意
 * 已认证用户可读"，新授权栈把公开受众收敛为资源自身的 `visibility` 列。四张受控资源主表
 * （agent_config / skill / mcp_server / provider）在任务 1.2 的 S2–S5 已全部切到新栈，回填之后
 * 不会丢失既有公开受众。
 *
 * 执行时机：注册进 `data-migrate` 注册表，由部署期入口 `db/data-migration-runner.ts` 在发布步骤执行一次
 * 并记入 `data_migrate_record`（启动序不再执行数据迁移，见 §6.3 / §10.6.2）。该步骤位于 DDL 迁移之后、
 * 新版本进程启动之前，因此仍早于 builtin 同步。`DROP TABLE resource_permission` 已按裁决推到**下一发布**（见
 * `db/schema.ts` 中三个 enum 与 `resourcePermission` 表处的 `removeWhen`），回填必须在该 DROP
 * 之前于全部环境执行完毕。回填只做"读授权 → 公开受众"的单向收敛，不回写授权表。
 *
 * 风险：`principal_type='organization'` 的记录没有任何写入方，一旦存在即说明数据形态超出本
 * 迁移的假设，此时直接失败并停止发布步骤（非 0 退出），等待人工处置——不猜测其语义，也不静默跳过。
 */

/** 归属列在主表上的受控资源；`resource_permission.resource_type` 与本表的资源类型一一对应。 */
type VisibilityTable = typeof agentConfig | typeof skill | typeof mcpServer | typeof provider;

interface ResourceTarget {
  readonly resourceType: string;
  readonly table: VisibilityTable;
}

const RESOURCE_TARGETS: readonly ResourceTarget[] = [
  { resourceType: "agent_config", table: agentConfig },
  { resourceType: "skill", table: skill },
  { resourceType: "mcp_server", table: mcpServer },
  { resourceType: "provider", table: provider },
];

/** 每批回填的行数；控制单条 UPDATE 的锁范围与事务时长。 */
const BATCH_SIZE = 500;

/**
 * `resource_permission.resource_id` 是 text 列，主表主键是 uuid。历史数据里非 uuid 的取值不可能
 * 命中任何主表行，直接在应用侧剔除比让整条语句报 `invalid input syntax for type uuid` 更可控；
 * 剔除不丢信息（该值本来就没有对应资源），但计数会一并排除，因此 pending 校验与回填口径一致。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 旧栈"任意已认证用户可读"的授权指向的资源 id。 */
async function listPublicReadResourceIds(resourceType: string): Promise<string[]> {
  const rows = await db
    .select({ resourceId: resourcePermission.resourceId })
    .from(resourcePermission)
    .where(
      and(
        eq(
          resourcePermission.resourceType,
          resourceType as (typeof resourcePermission.resourceType.enumValues)[number],
        ),
        eq(resourcePermission.principalType, "all"),
        eq(resourcePermission.action, "read"),
      ),
    );
  const ids = new Set<string>();
  for (const row of rows) {
    if (UUID_PATTERN.test(row.resourceId)) ids.add(row.resourceId);
  }
  return [...ids];
}

async function countOrganizationPrincipalGrants(): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(resourcePermission)
    .where(eq(resourcePermission.principalType, "organization"));
  return Number(rows[0]?.value ?? 0);
}

/** 把给定资源 id 中仍为 private 的行标记为 public，返回受影响行数。 */
async function markPublic(target: ResourceTarget, resourceIds: readonly string[]): Promise<number> {
  let updated = 0;
  for (let start = 0; start < resourceIds.length; start += BATCH_SIZE) {
    const batch = resourceIds.slice(start, start + BATCH_SIZE);
    const rows = await db
      .update(target.table)
      .set({ visibility: "public" })
      .where(and(ne(target.table.visibility, "public"), inArray(target.table.id, batch)))
      .returning({ id: target.table.id });
    updated += rows.length;
  }
  return updated;
}

/** 给定资源 id 中仍不是 public 的行数；回填完整性的判据。 */
async function countNonPublic(target: ResourceTarget, resourceIds: readonly string[]): Promise<number> {
  let total = 0;
  for (let start = 0; start < resourceIds.length; start += BATCH_SIZE) {
    const batch = resourceIds.slice(start, start + BATCH_SIZE);
    const rows = await db
      .select({ value: count() })
      .from(target.table)
      .where(and(ne(target.table.visibility, "public"), inArray(target.table.id, batch)));
    total += Number(rows[0]?.value ?? 0);
  }
  return total;
}

/** 补偿：把由公开读授权推导为 public 的行改回 private。 */
async function markPrivate(target: ResourceTarget, resourceIds: readonly string[]): Promise<number> {
  let updated = 0;
  for (let start = 0; start < resourceIds.length; start += BATCH_SIZE) {
    const batch = resourceIds.slice(start, start + BATCH_SIZE);
    const rows = await db
      .update(target.table)
      .set({ visibility: "private" })
      .where(and(eq(target.table.visibility, "public"), inArray(target.table.id, batch)))
      .returning({ id: target.table.id });
    updated += rows.length;
  }
  return updated;
}

export const _deps = {
  listPublicReadResourceIds,
  countOrganizationPrincipalGrants,
  markPublic,
  countNonPublic,
  markPrivate,
};

export function _resetDeps() {
  _deps.listPublicReadResourceIds = listPublicReadResourceIds;
  _deps.countOrganizationPrincipalGrants = countOrganizationPrincipalGrants;
  _deps.markPublic = markPublic;
  _deps.countNonPublic = countNonPublic;
  _deps.markPrivate = markPrivate;
}

/**
 * 公开受众是否已经收敛完成：不存在「有公开读授权但仍不是 public」的行。
 *
 * 回填只写「公开读授权已存在」的行，因此正常情况下这里必然为 0；非 0 说明 UPDATE 的判据与这里的判据口径
 * 不一致（例如批大小、id 过滤或状态过滤被改动），必须失败而不是写成完成记录。
 */
export async function verifyBackfillResourceVisibility(): Promise<void> {
  for (const target of RESOURCE_TARGETS) {
    const resourceIds = await _deps.listPublicReadResourceIds(target.resourceType);
    const pending = await _deps.countNonPublic(target, resourceIds);
    if (pending > 0) {
      throw new Error(`[data-migrate] 资源 '${target.resourceType}' 仍有 ${pending} 行未回填公开受众`);
    }
  }
}

/** 补偿入口：供发布回滚流程在需要撤销公开受众时调用。 */
export async function compensateBackfillResourceVisibility(context: DataMigrationContext): Promise<void> {
  for (const target of RESOURCE_TARGETS) {
    const resourceIds = await _deps.listPublicReadResourceIds(target.resourceType);
    if (resourceIds.length === 0) continue;
    const reverted = await _deps.markPrivate(target, resourceIds);
    context.log(`[data-migrate] compensate resource visibility type='${target.resourceType}' rows=${reverted}`);
  }
}

export const migrateBackfillResourceVisibility: DataMigration = {
  name: "access-control/20260919-backfill-resource-visibility",
  // 只读旧授权表并按资源 id 回填主表，不依赖任何其他数据迁移的写入结果。
  dependsOn: [],
  metadata: {
    expectedRows:
      "resource_permission 中 principal_type='all' AND action='read' 的去重 resource_id 数（仅统计可解析为 uuid 的取值）；" +
      "无此类授权的库与已回填过的库为 0 行",
    // 按 500 行一批 UPDATE 且每批独立提交，行锁随批释放；单批影响 4 张受控资源主表之一。
    lockRisk: "row-level",
    observableFields: ["resourceType", "rows"],
  },
  async run(context) {
    const organizationGrants = await _deps.countOrganizationPrincipalGrants();
    if (organizationGrants > 0) {
      throw new Error(
        `[data-migrate] resource_permission 存在 ${organizationGrants} 条 principal_type='organization' 记录，` +
          "超出本迁移的假设，停止回填并等待人工处置",
      );
    }

    for (const target of RESOURCE_TARGETS) {
      const resourceIds = await _deps.listPublicReadResourceIds(target.resourceType);
      if (resourceIds.length === 0) continue;
      const migrated = await _deps.markPublic(target, resourceIds);
      if (migrated > 0) {
        context.log(`[data-migrate] backfilled resource visibility type='${target.resourceType}' rows=${migrated}`);
      }
    }
  },
  verify: verifyBackfillResourceVisibility,
  compensation: {
    kind: "handler",
    // 回填是单向收敛，撤销即把由公开读授权推导出的 public 改回 private；只作用于仍有公开读授权的资源 id，
    // 因此不会波及迁移之后由用户自己设为 public 的其他资源。
    run: compensateBackfillResourceVisibility,
  },
};
