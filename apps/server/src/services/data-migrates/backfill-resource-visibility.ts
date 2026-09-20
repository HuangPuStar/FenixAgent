import { log } from "@fenix/logger";
import { and, count, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import { agentConfig, mcpServer, provider, resourcePermission, skill } from "../../db/schema";

/**
 * 把旧 `resource_permission` 的"公开读"授权回填到资源主表的 `visibility` 列。
 *
 * 背景：旧授权栈用 `resource_permission` 中 `principal_type='all' AND action='read'` 表达"任意
 * 已认证用户可读"，新授权栈把公开受众收敛为资源自身的 `visibility` 列。四张受控资源主表
 * （agent_config / skill / mcp_server / provider）在任务 1.2 的 S2–S5 已全部切到新栈，回填之后
 * 不会丢失既有公开受众。
 *
 * 执行时机：注册进 `data-migrate` 启动期 runner，在 builtin 同步之前执行一次并记入
 * `data_migrate_record`。`DROP TABLE resource_permission` 已按裁决推到**下一发布**（见
 * `db/schema.ts` 中三个 enum 与 `resourcePermission` 表处的 `removeWhen`），回填必须在该 DROP
 * 之前于全部环境执行完毕。回填只做"读授权 → 公开受众"的单向收敛，不回写授权表。
 *
 * 风险：`principal_type='organization'` 的记录没有任何写入方，一旦存在即说明数据形态超出本
 * 迁移的假设，此时直接失败并停止启动流程，等待人工处置——不猜测其语义，也不静默跳过。
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
  log,
};

export function _resetDeps() {
  _deps.listPublicReadResourceIds = listPublicReadResourceIds;
  _deps.countOrganizationPrincipalGrants = countOrganizationPrincipalGrants;
  _deps.markPublic = markPublic;
  _deps.countNonPublic = countNonPublic;
  _deps.markPrivate = markPrivate;
  _deps.log = log;
}

/** 公开受众是否已经收敛完成：不存在"有公开读授权但仍不是 public"的行。 */
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
export async function compensateBackfillResourceVisibility(): Promise<void> {
  for (const target of RESOURCE_TARGETS) {
    const resourceIds = await _deps.listPublicReadResourceIds(target.resourceType);
    if (resourceIds.length === 0) continue;
    const reverted = await _deps.markPrivate(target, resourceIds);
    _deps.log(`[data-migrate] compensate resource visibility type='${target.resourceType}' rows=${reverted}`);
  }
}

export const migrateBackfillResourceVisibility = {
  name: "access-control/20260919-backfill-resource-visibility",
  async run(): Promise<void> {
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
        _deps.log(`[data-migrate] backfilled resource visibility type='${target.resourceType}' rows=${migrated}`);
      }
    }

    // 回填本身只写"公开读授权已存在"的行，因此这里必须为 0；不为 0 说明语句与判据口径不一致。
    await verifyBackfillResourceVisibility();
  },
};
