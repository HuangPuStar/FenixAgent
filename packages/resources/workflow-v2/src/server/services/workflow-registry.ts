import { createLogger, requestAls } from "@fenix/logger";
import {
  appendAuditLog,
  CREATE_COMPENSATION_ACTION,
  PENDING_CLEANUP_RESULT,
} from "../repositories/audit-log-repository";
import {
  findActiveById,
  findActiveByUpstreamId,
  findAnyByUpstreamId,
  insertWorkflow,
  listActive,
  markPendingDelete,
  updateActiveName,
  updateActivePublishedVersion,
  type WorkflowRow,
} from "../repositories/workflow-registry-repository";

/**
 * 本地 workflow 注册表（归属校验的**唯一依据**）。
 *
 * 为什么必须有它：上游侧只校验「平台账号属于该 space」（`checkUserSpace`），**不校验 workflow ↔ App
 * 归属**，creator 也永远是平台账号——租户与用户归属无法由上游表达（设计 §1.4 / §3.3）。因此所有涉及
 * `workflow_id` 的请求都要先在本表回答「存在 + 属于当前组织 + 当前用户有权操作」，未命中一律 404，
 * 不泄漏资源存在性；跨组织隔离绝不依赖上游的成员关系校验。
 *
 * 一致性与删除（设计 §3.4）：本地是归属真相源，上游是 schema/版本/发布的真相源。删除是双方动作——
 * 先置本地软删（`sync_state` → `pending_delete` + `deleted_at`），再调上游删除；上游删除失败不改回
 * `active`，由对账任务重试，绝不把「上游可能还存在」的 workflow 从本地抹掉。
 *
 * 创建补偿（设计 §3.4「先上游后本地 + 失败补偿删除」）：本模块只做本地侧——落库失败时把上游对象记成
 * **待清理**（审计表 `workflow.create.compensation` / `pending_cleanup`，对账任务 4A 的输入），并把带
 * 原因的 {@link WorkflowRegistrationFailedError} 抛给调用方；**上游删除动作由调用方执行**（只有它持有
 * `space_id` 与上游调用端口，见 `routes/web/workflows.ts`）。
 *
 * 本文件的组织谓词全部下推给仓储（`repositories/workflow-registry-repository.ts`）：跨租户与不存在在
 * 返回值上同形，调用方据此统一 404。
 */

const logger = createLogger("wf2-registry");

export interface WorkflowRecord {
  /** 本地主键（uuid）；只服务我方路由与审计。 */
  id: string;
  organizationId: string;
  /** 上游 workflow ID（跨系统身份，唯一）。 */
  upstreamWorkflowId: string;
  /** 租户 App ID（上游的 `project_id`）。 */
  appId: string;
  name: string;
  ownerUserId: string;
  visibility: string;
  /** 上游侧最新发布版本；未发布为 null。 */
  publishedVersion: string | null;
  /** 软删状态；`pending_delete` 表示上游删除待对账任务重试。 */
  syncState: "active" | "pending_delete";
}

/** 列表项：注册表记录 + 控制台列表需要的时间戳（ISO 8601，跨协议层序列化的稳定形状）。 */
export interface WorkflowListItem extends WorkflowRecord {
  readonly updatedAt: string;
}

/** 组织内列表查询；`page` / `size` 由调用方保证 ≥ 1（路由层已校验）。 */
export interface WorkflowListInput {
  readonly page: number;
  readonly size: number;
  /** 名称包含匹配（大小写不敏感）；缺省不过滤。 */
  readonly name?: string;
}

export interface WorkflowListPage {
  readonly items: WorkflowListItem[];
  readonly total: number;
}

/**
 * 注册冲突原因。
 *
 * 三种情况对外同形（路由统一 409 且不回显任何已有记录字段），分开只服务日志与排障：
 * `pending_delete` 表示该上游 workflow 已由本组织登记且正在待删，`other_organization` 表示身份已被
 * 别的组织持有（**不得**把对方记录返回给调用方），`concurrent` 表示唯一索引冲突后已看不到占用行
 * （并发写入回滚等极端竞态）。
 */
export type WorkflowRegistrationConflictReason = "pending_delete" | "other_organization" | "concurrent";

/** `upstream_workflow_id` 已被占用：拒绝登记，且不向调用方泄漏占用方的任何字段。 */
export class WorkflowRegistrationConflictError extends Error {
  constructor(
    readonly upstreamWorkflowId: string,
    readonly reason: WorkflowRegistrationConflictReason,
  ) {
    super(`workflow ${upstreamWorkflowId} is already registered (${reason})`);
    this.name = "WorkflowRegistrationConflictError";
  }
}

/**
 * 本地登记失败。
 *
 * `cleanupMarkerRecorded` 说明「待清理」标记是否已落进审计表：为 true 时对账任务能捞到这条孤儿记录，
 * 为 false（数据库整体不可用等）时孤儿只能靠对账任务反向扫描上游发现，调用方据此决定告警强度。
 * `cause` 保留原始失败以供服务端日志，**不得**进入面向用户的响应。
 */
export class WorkflowRegistrationFailedError extends Error {
  constructor(
    readonly upstreamWorkflowId: string,
    readonly cleanupMarkerRecorded: boolean,
    options: { cause: unknown },
  ) {
    super(`workflow ${upstreamWorkflowId} 本地登记失败，上游对象可能成为孤儿`, options);
    this.name = "WorkflowRegistrationFailedError";
  }
}

/** 目标在本地不可见：不存在、已软删或属于别的组织（三者对外同形）。 */
export class WorkflowNotFoundError extends Error {
  constructor(readonly upstreamWorkflowId: string) {
    super(`workflow ${upstreamWorkflowId} not found in this organization`);
    this.name = "WorkflowNotFoundError";
  }
}

/** 表行 → 领域记录。 */
function toRecord(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    upstreamWorkflowId: row.upstreamWorkflowId,
    appId: row.appId,
    name: row.name,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    publishedVersion: row.publishedVersion,
    // 数据库列是 text（不加 CHECK 以免影响后续状态扩展），这里收窄成契约里的两态。
    syncState: row.syncState === "pending_delete" ? "pending_delete" : "active",
  };
}

/** 唯一索引冲突判定：Drizzle 把驱动错误包在 `cause` 里，逐层下钻（同 `sandbox` 包的口径）。 */
function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" ||
    (typeof candidate.message === "string" &&
      (candidate.message.includes("duplicate key") || candidate.message.includes("unique constraint"))) ||
    isUniqueConstraintError(candidate.cause)
  );
}

/** 冲突原因归因；只在「唯一索引冲突」路径调用。 */
function conflictReason(existing: WorkflowRow, organizationId: string): WorkflowRegistrationConflictReason {
  if (existing.organizationId !== organizationId) return "other_organization";
  return existing.syncState === "active" ? "concurrent" : "pending_delete";
}

/** 按组织 + 上游 workflow ID 查记录；未命中（含已软删、跨组织）返回 null（调用方据此返回 404）。 */
export async function findWorkflowByUpstreamId(
  orgId: string,
  upstreamWorkflowId: string,
): Promise<WorkflowRecord | null> {
  const row = await findActiveByUpstreamId(orgId, upstreamWorkflowId);
  return row ? toRecord(row) : null;
}

/** 按组织 + 本地主键查记录；未命中（含已软删、跨组织）返回 null。 */
export async function findWorkflowById(orgId: string, workflowId: string): Promise<WorkflowRecord | null> {
  const row = await findActiveById(orgId, workflowId);
  return row ? toRecord(row) : null;
}

/** 列出当前组织未软删的 workflow；已软删（`pending_delete`）的一律不可见。 */
export async function listWorkflows(orgId: string, input: WorkflowListInput): Promise<WorkflowListPage> {
  const { rows, total } = await listActive({
    organizationId: orgId,
    name: input.name,
    limit: input.size,
    offset: (input.page - 1) * input.size,
  });
  return { items: rows.map((row) => ({ ...toRecord(row), updatedAt: row.updatedAt.toISOString() })), total };
}

/**
 * 登记一条新 workflow（创建流程的第二步）。
 *
 * 创建走「先上游后本地 + 失败补偿删除」（设计 §3.4）：上游建成后本地写入失败，必须让上游对象可被
 * 清理，否则会留下无归属的孤儿 workflow。
 *
 * 幂等：同一上游 workflow 在**同一组织**内重复登记时返回已存在的记录，而不是原始 DB 错误（重放创建
 * 请求、上游重试回调都会走到这里）。身份已被别的组织持有时抛 {@link WorkflowRegistrationConflictError}，
 * 且不返回对方记录的任何字段——那会把跨租户的存在性变成探测面。
 */
export async function registerWorkflow(
  input: Omit<WorkflowRecord, "id" | "syncState" | "publishedVersion">,
): Promise<WorkflowRecord> {
  // 前置查询与插入同在一个 try 里：前置查询也可能因数据库不可用而失败，而**任何**本地读写失败都要走
  // 「写待清理标记 + 抛补偿错误」这条路，否则上游刚创建的对象会既没有本地归属、也没有补偿依据。
  try {
    // 前置查询让「重复登记」走正常返回路径；插入仍可能撞唯一索引（并发登记），故 catch 里再归因一次。
    const existing = await findAnyByUpstreamId(input.upstreamWorkflowId);
    if (existing) {
      if (existing.organizationId === input.organizationId && existing.syncState === "active")
        return toRecord(existing);
      throw new WorkflowRegistrationConflictError(
        input.upstreamWorkflowId,
        conflictReason(existing, input.organizationId),
      );
    }

    return toRecord(await insertWorkflow(input));
  } catch (error) {
    // 冲突是业务结论（身份已被占用），不是「登记失败」：不写补偿标记，原样上抛由调用方映射 409。
    if (error instanceof WorkflowRegistrationConflictError) throw error;

    if (isUniqueConstraintError(error)) {
      const raced = await findAnyByUpstreamId(input.upstreamWorkflowId).catch((attributionError: unknown) => {
        // 归因查询失败不改变结论（身份确实被占用），只影响 reason 的精度；记日志保留诊断上下文。
        logger.warn("workflow 注册冲突归因查询失败，按并发冲突处理", {
          upstreamWorkflowId: input.upstreamWorkflowId,
          attributionError: attributionError instanceof Error ? attributionError.message : String(attributionError),
        });
        return;
      });
      if (raced && raced.organizationId === input.organizationId && raced.syncState === "active")
        return toRecord(raced);
      throw new WorkflowRegistrationConflictError(
        input.upstreamWorkflowId,
        raced ? conflictReason(raced, input.organizationId) : "concurrent",
      );
    }

    const cleanupMarkerRecorded = await recordCleanupMarker(input, error);
    throw new WorkflowRegistrationFailedError(input.upstreamWorkflowId, cleanupMarkerRecorded, { cause: error });
  }
}

/**
 * 重命名未软删记录；返回更新后的记录，未命中（不存在、已软删或跨组织）返回 null。
 *
 * 只改本地镜像名：上游侧的改名由调用方经 `update_meta` 完成，本地名是列表与检索用的镜像。
 */
export async function renameWorkflow(orgId: string, workflowId: string, name: string): Promise<WorkflowRecord | null> {
  const row = await updateActiveName(orgId, workflowId, name);
  return row ? toRecord(row) : null;
}

/**
 * 写回发布成功后的新版本；未命中（不存在、已软删或跨组织）返回 null。
 *
 * 调用时机**只能**是上游 `publish` 成功之后（见仓储同名函数的注释）。返回 null 不代表发布失败——上游
 * 已经发布了，只是本地行在并发下被软删/迁移；调用方据此记日志与审计，**不**把已成功的发布改判为失败。
 */
export async function recordPublishedVersion(
  orgId: string,
  upstreamWorkflowId: string,
  publishedVersion: string,
): Promise<WorkflowRecord | null> {
  const row = await updateActivePublishedVersion(orgId, upstreamWorkflowId, publishedVersion);
  return row ? toRecord(row) : null;
}

/**
 * 软删（`sync_state` → `pending_delete` + `deleted_at`）；上游删除结果由对账任务收敛。
 *
 * 重复删除或跨组织调用抛 {@link WorkflowNotFoundError}：静默成功会让上层在「这行不属于你」时也返回成功。
 */
export async function softDeleteWorkflow(orgId: string, upstreamWorkflowId: string): Promise<void> {
  const affected = await markPendingDelete(orgId, upstreamWorkflowId);
  if (affected === 0) throw new WorkflowNotFoundError(upstreamWorkflowId);
}

/**
 * 落库失败时写「待清理」标记；返回标记是否落库成功。
 *
 * 标记只能进审计表（本地注册行没写进去，也没有第二个可写对象），对账任务按
 * `action = workflow.create.compensation AND result = pending_cleanup` 捞取后删除上游侧对象。
 * 标记写入本身失败（数据库整体不可用）时不再抛错——原始失败必须原样上抛，否则调用方看到的是
 * 「标记失败」而不是「登记失败」，补偿决策会走错分支。
 */
async function recordCleanupMarker(
  input: Omit<WorkflowRecord, "id" | "syncState" | "publishedVersion">,
  cause: unknown,
): Promise<boolean> {
  try {
    await appendAuditLog({
      organizationId: input.organizationId,
      actorUserId: input.ownerUserId,
      action: CREATE_COMPENSATION_ACTION,
      upstreamWorkflowId: input.upstreamWorkflowId,
      requestId: requestAls.getStore()?.requestId ?? null,
      result: PENDING_CLEANUP_RESULT,
      errorCode: "WORKFLOW_REGISTRATION_FAILED",
    });
    return true;
  } catch (markerError) {
    // 只记诊断上下文，不含凭据与用户数据原文（upstreamWorkflowId 是上游标识，允许入日志）。
    logger.error("workflow 注册补偿标记写入失败，孤儿只能靠对账反向扫描发现", {
      upstreamWorkflowId: input.upstreamWorkflowId,
      markerError: markerError instanceof Error ? markerError.message : String(markerError),
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return false;
  }
}
