import { workflowV2Workflow } from "@fenix/resource-workflow-v2/db";
import { and, asc, count, desc, eq, ilike, isNotNull, isNull } from "drizzle-orm";
import { getWorkflowV2Database } from "./database";

/**
 * `workflow_v2_workflow` 的持久化访问层（注册表唯一真相源的存储面）。
 *
 * 只封装持久化与谓词，不做归属判断、不解释业务：**每一个读/写函数都要求调用方显式传入
 * `organizationId`**，组织谓词由本层拼进 SQL（而不是读到内存再比较），跨租户的行不可能被本层返回。
 * 唯一的例外是 {@link findAnyByUpstreamId}：它只服务「`upstream_workflow_id` 唯一索引冲突」的归因，返回值
 * **不得**向上层业务暴露（见该函数的注释）。
 *
 * 软删口径：`deleted_at IS NULL` 是「未删除」的谓词，`sync_state` 只是同一条事实的可见表达。所有列表与
 * 单查一律带该谓词；`pending_delete` 的行只在对账任务（4A）与冲突归因里出现。
 */

/** 表行类型；字段名与 `db/schema.ts` 的列一一对应。 */
export type WorkflowRow = typeof workflowV2Workflow.$inferSelect;

/** 新登记一条 workflow 所需的列值（`id` / 时间戳走列默认值）。 */
export interface WorkflowInsert {
  readonly organizationId: string;
  readonly upstreamWorkflowId: string;
  readonly appId: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly visibility: string;
}

/** 组织内列表查询：分页与名称模糊匹配都是可选条件下的固定谓词组合。 */
export interface WorkflowListFilter {
  readonly organizationId: string;
  /** 名称包含匹配（大小写不敏感）；缺省不过滤。 */
  readonly name?: string;
  readonly limit: number;
  readonly offset: number;
}

/** 「本组织 + 未软删」——所有面向业务的读写共用这一条固定谓词。 */
function activeScope(organizationId: string) {
  return and(eq(workflowV2Workflow.organizationId, organizationId), isNull(workflowV2Workflow.deletedAt));
}

/** 插入一条 workflow；唯一索引冲突（同 `upstream_workflow_id`）由调用方按幂等语义处理，本层不吞错。 */
export async function insertWorkflow(input: WorkflowInsert): Promise<WorkflowRow> {
  const [row] = await getWorkflowV2Database().insert(workflowV2Workflow).values(input).returning();
  // `returning()` 在插入成功时必有且仅有一行；缺行说明驱动或连接状态异常，必须显式失败而不是返回
  // undefined 让调用方把「没拿到记录」误当成「登记成功」。
  if (!row) throw new Error("workflow_v2_workflow insert returned no row");
  return row;
}

/** 按组织 + 上游 workflow ID 查未软删记录；未命中返回 undefined。 */
export async function findActiveByUpstreamId(
  organizationId: string,
  upstreamWorkflowId: string,
): Promise<WorkflowRow | undefined> {
  const [row] = await getWorkflowV2Database()
    .select()
    .from(workflowV2Workflow)
    .where(and(activeScope(organizationId), eq(workflowV2Workflow.upstreamWorkflowId, upstreamWorkflowId)))
    .limit(1);
  return row;
}

/**
 * 按上游 workflow ID 查记录，**不限组织、含已软删**。
 *
 * 只用于「插入撞上 `upstream_workflow_id` 唯一索引」时的归因：判断这次冲突是同组织的重复登记（幂等返回
 * 已存在记录）还是别的组织已持有该身份（拒绝，且不得回显任何字段）。返回值属于**跨租户读**，调用方
 * 只允许比较 `organizationId` / `syncState`，不得把行内容回给调用者，否则等于把他人组织的存在性
 * 变成探测面。
 */
export async function findAnyByUpstreamId(upstreamWorkflowId: string): Promise<WorkflowRow | undefined> {
  const [row] = await getWorkflowV2Database()
    .select()
    .from(workflowV2Workflow)
    .where(eq(workflowV2Workflow.upstreamWorkflowId, upstreamWorkflowId))
    .limit(1);
  return row;
}

/** 按组织 + 本地主键查未软删记录；未命中返回 undefined（跨组织与不存在同形）。 */
export async function findActiveById(organizationId: string, id: string): Promise<WorkflowRow | undefined> {
  const [row] = await getWorkflowV2Database()
    .select()
    .from(workflowV2Workflow)
    .where(and(activeScope(organizationId), eq(workflowV2Workflow.id, id)))
    .limit(1);
  return row;
}

/** 列当前组织未软删的 workflow（名称倒序无关紧要，按创建时间倒序），并返回同一谓词下的总数。 */
export async function listActive(filter: WorkflowListFilter): Promise<{ rows: WorkflowRow[]; total: number }> {
  const db = getWorkflowV2Database();
  const where = filter.name
    ? and(activeScope(filter.organizationId), ilike(workflowV2Workflow.name, `%${filter.name}%`))
    : activeScope(filter.organizationId);

  const rows = await db
    .select()
    .from(workflowV2Workflow)
    .where(where)
    .orderBy(desc(workflowV2Workflow.createdAt), asc(workflowV2Workflow.id))
    .limit(filter.limit)
    .offset(filter.offset);
  const [totalRow] = await db.select({ value: count() }).from(workflowV2Workflow).where(where);
  // `count()` 在有 WHERE 的聚合下恒返回一行；缺行说明驱动异常，按 0 处理会让分页静默错位，故显式失败。
  if (!totalRow) throw new Error("workflow_v2_workflow count returned no row");
  return { rows, total: totalRow.value };
}

/** 改名未软删记录；返回更新后的行，未命中（或已软删）返回 undefined。 */
export async function updateActiveName(
  organizationId: string,
  id: string,
  name: string,
): Promise<WorkflowRow | undefined> {
  const [row] = await getWorkflowV2Database()
    .update(workflowV2Workflow)
    .set({ name, updatedAt: new Date() })
    .where(and(activeScope(organizationId), eq(workflowV2Workflow.id, id)))
    .returning();
  return row;
}

/**
 * 写回「已发布版本」；返回更新后的行，未命中（或已软删）返回 undefined。
 *
 * 只由发布闭环调用，且**只能**在上游 publish 成功之后调用：该列是版本自增的唯一依据（设计 §4.2），写早于
 * 上游会让下一次发布拿着一个尚未发布的版本号去自增，与上游记录错位。
 */
export async function updateActivePublishedVersion(
  organizationId: string,
  upstreamWorkflowId: string,
  publishedVersion: string,
): Promise<WorkflowRow | undefined> {
  const [row] = await getWorkflowV2Database()
    .update(workflowV2Workflow)
    .set({ publishedVersion, updatedAt: new Date() })
    .where(and(activeScope(organizationId), eq(workflowV2Workflow.upstreamWorkflowId, upstreamWorkflowId)))
    .returning();
  return row;
}

/**
 * 置软删（`sync_state` = `pending_delete` + `deleted_at`），返回受影响行数。
 *
 * 行保留：上游侧删除由对账任务重试，删掉本地行会让「上游还存在」的对象失去归属记录。受影响行数为 0
 * 表示目标不存在、已软删或不属于该组织，调用方据此判定失败。
 */
export async function markPendingDelete(organizationId: string, upstreamWorkflowId: string): Promise<number> {
  const rows = await getWorkflowV2Database()
    .update(workflowV2Workflow)
    .set({ syncState: "pending_delete", deletedAt: new Date(), updatedAt: new Date() })
    .where(and(activeScope(organizationId), eq(workflowV2Workflow.upstreamWorkflowId, upstreamWorkflowId)))
    .returning({ id: workflowV2Workflow.id });
  return rows.length;
}

// ── 对账面（4A）──────────────────────────────────────────────
//
// 下面三个函数只服务对账任务：它要跨组织读待收敛的行（`listPendingDelete`）、在上游确认删除后终结本地行
// （`purgePendingDelete`），并在补写孤儿前知道「这个上游身份本地是否已经认识」（`listUpstreamIdsByOrganization`）。
// 三者都不放宽上面那条纪律：需要组织谓词的照样下推（`purgePendingDelete`），确实要跨组织读的
// （`listPendingDelete`）在函数注释里写明它对调用方的约束。

/** 待收敛的软删行（对账任务的输入）；只带收敛所需列，避免把行内容带出对账路径。 */
export interface PendingDeleteRow {
  readonly id: string;
  readonly organizationId: string;
  readonly upstreamWorkflowId: string;
  /** 软删时刻；年龄上限按它算（进程重启后仍成立的那条持久化预算）。 */
  readonly deletedAt: Date;
}

/**
 * 列 `sync_state = 'pending_delete'` 且已有 `deleted_at` 的行，按软删时刻从早到晚，最多 `limit` 行。
 *
 * **跨组织读**：收敛动作的对象是「上游可能仍然存在」的对象，与请求方组织无关，因此这里没有组织谓词——
 * 调用方（对账任务）不得把行内容回给任何请求方，只能用于调用上游删除与写审计。
 */
export async function listPendingDelete(limit: number): Promise<PendingDeleteRow[]> {
  const rows = await getWorkflowV2Database()
    .select({
      id: workflowV2Workflow.id,
      organizationId: workflowV2Workflow.organizationId,
      upstreamWorkflowId: workflowV2Workflow.upstreamWorkflowId,
      deletedAt: workflowV2Workflow.deletedAt,
    })
    .from(workflowV2Workflow)
    .where(and(eq(workflowV2Workflow.syncState, "pending_delete"), isNotNull(workflowV2Workflow.deletedAt)))
    .orderBy(asc(workflowV2Workflow.deletedAt))
    .limit(limit);
  // 谓词保证 `deleted_at` 非空，但列类型仍是可空（同一列也服务 `active` 行）；缺值说明行状态被外部改写，
  // 对账的年龄预算算不出来，宁可不收敛这一行也不能拿 `now` 当软删时刻（那会让它永远「刚删」）。
  return rows.flatMap((row) => (row.deletedAt === null ? [] : [{ ...row, deletedAt: row.deletedAt }]));
}

/**
 * 上游删除确认后终结本地行（硬删），返回受影响行数。
 *
 * 为什么是硬删而不是留墓碑：行从软删那一刻起就已经不可见，「上游可能仍在」这一事实也已由上游确认消除；
 * 留 Tombstone 只会白占 `upstream_workflow_id` 的唯一索引并让「已终结」与「待收敛」两种语义都叫
 * `pending_delete`。归属事实由本轮审计的 `workflow.delete.upstream` / `reconciled` 流水承接。
 *
 * 组织谓词 + `sync_state` 谓词同时下推：只能终结**本组织**且**仍是待收敛态**的行（并发下已被别的路径
 * 改回 `active`——例如重登后重建同 id 对象——时返回 0，不得误删）。
 */
export async function purgePendingDelete(organizationId: string, id: string): Promise<number> {
  const rows = await getWorkflowV2Database()
    .delete(workflowV2Workflow)
    .where(
      and(
        eq(workflowV2Workflow.organizationId, organizationId),
        eq(workflowV2Workflow.id, id),
        eq(workflowV2Workflow.syncState, "pending_delete"),
      ),
    )
    .returning({ id: workflowV2Workflow.id });
  return rows.length;
}

/**
 * 列本组织**全部**（含已软删）已登记的上游 workflow 身份。
 *
 * 对账的孤儿补写按它做「本地是否已认识」的判据：只查未软删行会把 `pending_delete` 的对象误判成孤儿，
 * 进而对同 id 撞上唯一索引（或更糟——在上游删除确认前把它写成别的组织的行）。
 */
export async function listUpstreamIdsByOrganization(organizationId: string): Promise<string[]> {
  const rows = await getWorkflowV2Database()
    .select({ upstreamWorkflowId: workflowV2Workflow.upstreamWorkflowId })
    .from(workflowV2Workflow)
    .where(eq(workflowV2Workflow.organizationId, organizationId));
  return rows.map((row) => row.upstreamWorkflowId);
}
