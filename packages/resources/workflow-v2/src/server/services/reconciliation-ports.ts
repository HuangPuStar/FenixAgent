/**
 * 对账任务（4A）的外部依赖端口与失败分类。
 *
 * 端口抽出来的理由：本轮的全部判定（次数上限、退避窗口、归属判据、失败分类）都是**纯逻辑**，用真库测试
 * 会把「退避是否生效」「越权对象是否被拒」这类断言绑在 SQL 行为上；端口注入让这些判定可以在没有数据库的
 * 环境里被精确驱动（同 `@fenix/resource-machine` 的 `setRegistryHeartbeatDeps` 口径）。生产取值即本包
 * 仓储与 `callUpstream`，不存在第二套实现。
 *
 * 失败分类也放这里：`pending_delete` 收敛与孤儿扫描两条路径必须用**同一份**分类（否则同一个传输错误在
 * 两个计数里各算一类），并且它与 `upstream-client` / 控制面的 502/503/504 分类同源。
 */

import {
  appendAuditLog,
  type CompensationMarkerRow,
  findCompensationMarkers,
} from "../repositories/audit-log-repository";
import { listOrgAppBindings } from "../repositories/tenant-binding-repository";
import {
  findAnyByUpstreamId,
  insertWorkflow,
  listPendingDelete,
  listUpstreamIdsByOrganization,
  purgePendingDelete,
  type WorkflowInsert,
  type WorkflowRow,
} from "../repositories/workflow-registry-repository";
import { findPlatformAccount } from "./platform-account-bootstrap";
import {
  callUpstream,
  transportFailureKind,
  type UpstreamCallResult,
  UpstreamCircuitOpenError,
} from "./upstream-client";

/** `callUpstream` 的形状（同 `services/upstream-client.ts` 的导出）。 */
export type ReconciliationUpstreamCall = (input: {
  path: string;
  body?: unknown;
  method?: "GET" | "POST";
}) => Promise<UpstreamCallResult>;

/**
 * 审计主体占位符：对账没有请求上下文，也没有发起人。
 *
 * 用明显非 UUID 的固定值而不是借某个真实用户 ID：审计流水必须能区分「人做的」与「系统做的」，借用发起
 * 删除的用户会让「谁终结了这行」变成错的事实。
 */
export const RECONCILIATION_ACTOR_USER_ID = "system:workflow-v2-reconciliation";

/**
 * 补写行的归属用户占位符：孤儿对象由平台账号创建，上游侧**不存在**对应的我方用户（设计 §3.3）。
 *
 * 同理不借任何真实用户 ID——那等于凭空把对象划给某个人；控制台不渲染该列，运维按这个可检索的标记
 * 就能筛出「无主」的记录。
 */
export const BACKFILLED_OWNER_USER_ID = "system:orphan-backfill";

/** 对账任务的外部依赖；生产实现见 {@link productionPorts}。 */
export interface ReconciliationPorts {
  /** 时钟（毫秒）；测试用它把退避窗口与年龄上限推到边界。 */
  readonly clock: () => number;
  readonly callUpstream: ReconciliationUpstreamCall;
  readonly listPendingDelete: (
    limit: number,
  ) => Promise<readonly { id: string; organizationId: string; upstreamWorkflowId: string; deletedAt: Date }[]>;
  readonly purgePendingDelete: (organizationId: string, id: string) => Promise<number>;
  readonly listKnownUpstreamIds: (organizationId: string) => Promise<readonly string[]>;
  readonly listOrgApps: () => Promise<readonly { organizationId: string; appId: string }[]>;
  readonly findPlatformSpaceId: () => Promise<string | null>;
  /** 跨组织读：只用于回答「这个身份是否已被别的组织登记」，返回值不得外泄给请求方。 */
  readonly findRegisteredId: (upstreamWorkflowId: string) => Promise<WorkflowRow | undefined>;
  readonly findCompensationMarkers: (
    upstreamWorkflowIds: readonly string[],
  ) => Promise<readonly CompensationMarkerRow[]>;
  readonly insertWorkflow: (input: WorkflowInsert) => Promise<unknown>;
  readonly appendAuditLog: (entry: Parameters<typeof appendAuditLog>[0]) => Promise<void>;
}

/** 生产端口：只做类型收窄，不做行为包装。 */
const productionPorts: ReconciliationPorts = {
  clock: () => Date.now(),
  callUpstream: (input) => callUpstream(input),
  listPendingDelete,
  purgePendingDelete,
  listKnownUpstreamIds: listUpstreamIdsByOrganization,
  listOrgApps: listOrgAppBindings,
  findPlatformSpaceId: async () => (await findPlatformAccount())?.platformSpaceId ?? null,
  findRegisteredId: findAnyByUpstreamId,
  findCompensationMarkers,
  insertWorkflow,
  appendAuditLog,
};

let injectedPorts: Partial<ReconciliationPorts> | null = null;

/** 端口按**调用时**读取，用例可在模块导入之后登记替身。 */
export function readPorts(): ReconciliationPorts {
  return injectedPorts === null ? productionPorts : { ...productionPorts, ...injectedPorts };
}

/** 测试用：替换对账依赖端口（不改变生产路径）。 */
export function setReconciliationPorts(overrides: Partial<ReconciliationPorts>): void {
  injectedPorts = { ...injectedPorts, ...overrides };
}

/** 测试用：清空端口替身。 */
export function resetReconciliationPorts(): void {
  injectedPorts = null;
}

/** 失败原因分类；只由传输层标签与上游业务码归类，不含任何凭据或响应原文。 */
export type ReconciliationFailureReason =
  | "timeout"
  | "network"
  | "session_unavailable"
  | "circuit_open"
  | "upstream_rejected"
  | "local_failure"
  /** 本轮的扫描/处理预算用尽（达到页数或候选数上限），剩余对象留待下一轮。 */
  | "budget_exhausted"
  | "unknown";

/** 一轮的失败分类账：非空即表示本轮不完整（报告里的 `degraded`）。 */
export type FailureTally = Map<ReconciliationFailureReason, number>;

/** 记一笔失败分类。 */
export function tallyFailure(tally: FailureTally, reason: ReconciliationFailureReason): void {
  tally.set(reason, (tally.get(reason) ?? 0) + 1);
}

/** 分类账 → 报告里的字面量对象（可结构化日志直接序列化）。 */
export function tallyToRecord(tally: FailureTally): Readonly<Partial<Record<ReconciliationFailureReason, number>>> {
  return Object.fromEntries(tally) as Partial<Record<ReconciliationFailureReason, number>>;
}

/** 单轮的执行上下文；`signal` 由调度器给出（停止时中止在途的一轮）。 */
export interface ReconciliationRunContext {
  readonly now: number;
  readonly signal: AbortSignal | undefined;
  readonly failures: FailureTally;
}

/** 本轮是否已被取消：两段收敛循环在每个条目之间检查，保证停止是**有界**的（不会卡在长循环里）。 */
export function isCancelled(context: ReconciliationRunContext): boolean {
  return context.signal?.aborted === true;
}

/** 对象收窄（上游响应体一律先经它再取值）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读上游信封里的数字业务码；非数字返回 null（调用方只判 `=== 0`）。 */
export function readUpstreamCode(body: unknown): number | null {
  if (!isRecord(body)) return null;
  return typeof body.code === "number" ? body.code : null;
}

/** `delete` 用 `data.status === 0` 表达成功，没有 `code` 语义（契约快照 §3 F8）。 */
export function isDeleteAccepted(result: UpstreamCallResult): boolean {
  return result.status === 200 && isRecord(result.body) && isRecord(result.body.data) && result.body.data.status === 0;
}

/** 传输/会话级失败的分类；与 `upstream-client` / 控制面的分类同源，不另立一套。 */
export function classifyThrownFailure(error: unknown): ReconciliationFailureReason {
  // 熔断短路必须单独成类：`transportFailureKind` 对它是 null（短路没有触达上游、不计入熔断），但对账要能
  // 分辨「本轮上游已经确定不可用」——那是「马上停止继续打上游」的信号，而不是一次普通的网络抖动。
  if (error instanceof UpstreamCircuitOpenError) return "circuit_open";
  const kind = transportFailureKind(error);
  if (kind === "timeout") return "timeout";
  if (kind === "network") return "network";
  if (kind === "session") return "session_unavailable";
  return "unknown";
}

/** 上游返回了响应但删除未被接受：上游活着、拒绝了这个请求（完全无 Cookie 的 401 除外，那是会话问题）。 */
export function classifyRejectedResponse(result: UpstreamCallResult): ReconciliationFailureReason {
  return result.status === 401 ? "session_unavailable" : "upstream_rejected";
}
