/**
 * `/web/workflow-v2/workflows*` 控制面的共享装配件：失败信封、主体解析、上游调用结果判定与**统一的失败映射**。
 *
 * 为什么独立成文件：`workflows.ts` 里四条 CRUD handler 与发布 handler 都要用同一份口径，而错误映射尤其
 * 不能分叉——3C 要求「熔断打开态与既有 `mapUpstreamFailure` 的 502/503/504/500 分类一致，不造第二套」，
 * 因此分类只写在本文件一处，由所有 handler 共用。
 *
 * 与画布面（`services/canvas-passthrough.ts` 的 `mapUpstreamFailure`）的关系：**同一套语义、两种信封**。
 * 画布面回上游信封 `{code,msg}`，本面回我方 `{success,error}`；分类口径逐档对齐——
 * 超时 504 / 网络 502 / 会话不可用 503 / 熔断打开 503 / 未预期 502（画布面为 500）。
 */

import { createLogger } from "@fenix/logger";
import type { TenantBindingSnapshot } from "../../repositories/tenant-binding-repository";
import { findTenantBinding } from "../../repositories/tenant-binding-repository";
import {
  transportFailureKind,
  UPSTREAM_PANIC_CODE,
  type UpstreamCallInput,
  type UpstreamCallResult,
  UpstreamCircuitOpenError,
} from "../../services/upstream-client";
import { UpstreamSessionUnavailableError } from "../../services/upstream-session";
import type { WorkflowV2ActorContext } from "../dependencies";

const logger = createLogger("wf2-workflows");

/** 失败信封；文案一律是我方固定文案，不含上游原文与内部实现。 */
export interface Failure {
  readonly code: string;
  readonly message: string;
}

/** 控制面失败：失败体 + 由分类决定的 HTTP 状态（调用方只负责 `status(...)` 转发）。 */
export interface HttpFailure {
  readonly httpStatus: number;
  readonly body: Failure;
}

/**
 * 上游失败的审计结果标签：`upstream_rejected` 表示上游活着但拒绝了请求，其余（超时/网络/会话/熔断）一律
 * `upstream_unavailable`。与响应错误码同源（`UPSTREAM_REJECTED` vs 其它），不另立一套判定。
 */
export const upstreamAuditResult = (failure: HttpFailure): string =>
  failure.body.code === "UPSTREAM_REJECTED" ? "upstream_rejected" : "upstream_unavailable";

/**
 * 组装失败信封；**HTTP 状态由调用处的 `status(code, ...)` 给出**。
 *
 * 不能把错误体挂在默认的 200 上：各路由为 200 声明的是 `WebOkSchema`，Elysia 的响应校验会把它判成
 * 422（`{"type":"validation","on":"response"}`），客户端拿到的就不是业务错误码了。
 */
export const failBody = (error: Failure) => ({ success: false as const, error });

/** 会话守卫未写入组织上下文（已认证但缺 active organization）。 */
export const UNAUTHENTICATED_FAILURE: Failure = { code: "UNAUTHENTICATED", message: "缺少组织上下文" };

/** 目标在本地不可见：不存在、已软删或跨组织（三者对外同形，避免存在性泄漏）。 */
export const NOT_FOUND_FAILURE: Failure = { code: "WORKFLOW_NOT_FOUND", message: "工作流不存在" };

/** 上游调用端口；与 `callUpstream` 同形，缺省即真实实现。 */
export type WorkflowV2UpstreamCall = (input: UpstreamCallInput) => Promise<UpstreamCallResult>;

/** 从会话守卫写入的 `store.authContext` 取主体；缺组织或用户上下文时返回 null（路由回 401）。 */
export function readActor(store: unknown): WorkflowV2ActorContext | null {
  const candidate = (store as { authContext?: Partial<WorkflowV2ActorContext> } | null)?.authContext;
  if (!candidate || typeof candidate.organizationId !== "string" || typeof candidate.userId !== "string") return null;
  if (candidate.organizationId.length === 0 || candidate.userId.length === 0) return null;
  return { organizationId: candidate.organizationId, userId: candidate.userId };
}

/** 读上游信封里的嵌套字段（如 `{data:{status:0}}`）；路径不存在或值为 null 时返回 null。 */
export function readPath(body: unknown, path: readonly string[]): unknown {
  let current: unknown = body;
  for (const key of path) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? null;
}

/** 上游业务成功 = HTTP 200 且 `code === 0`（业务失败多为 HTTP 200 + `code≠0`，见契约快照 §3 F5）。 */
export const isUpstreamSuccess = (result: UpstreamCallResult): boolean =>
  result.status === 200 && readPath(result.body, ["code"]) === 0;

/** `delete` / `batch_delete` 用 `data.status === 0` 表达成功，没有 `code` 语义（契约快照 §3 F8）。 */
export const isUpstreamDeleteAccepted = (result: UpstreamCallResult): boolean =>
  result.status === 200 && readPath(result.body, ["data", "status"]) === 0;

/** 只取诊断用的一行错误描述；不含凭据与上游原文。 */
const describeError = (error: unknown): unknown => (error instanceof Error ? error.message : String(error));

/**
 * 上游调用失败的分类与控制面映射（3C 复核后的唯一口径，与画布面逐档一致）。
 *
 * - 熔断打开（`UpstreamCircuitOpenError`，未发出请求）→ 503 `UPSTREAM_UNAVAILABLE`；
 * - 会话不可用（登录失败、重放仍失效）→ 503 `PLATFORM_SESSION_UNAVAILABLE`；
 * - 超时 → 504 `UPSTREAM_TIMEOUT`；网络错误 → 502 `UPSTREAM_UNAVAILABLE`；其余未预期 → 502（保守，
 *   与改造前的行为一致）；
 * - 上游返回了带业务码的响应 → 502 `UPSTREAM_REJECTED`（上游活着，拒绝了这个请求）。
 *
 * 日志保留 `upstreamStatus` / `upstreamCode` 供排障；`msg` 只截断入日志——panic 码的 `msg` 是 Go 堆栈（含绝对路径
 * 与内部函数名），永不进入响应（冻结 §6）。
 */
export function upstreamFailure(
  action: string,
  outcome: { thrown: unknown } | { result: UpstreamCallResult },
  context: Record<string, unknown>,
): HttpFailure {
  if ("thrown" in outcome) {
    const error = outcome.thrown;
    const detail = { ...context, error: describeError(error) };
    if (error instanceof UpstreamCircuitOpenError) {
      logger.warn(`workflow-v2 ${action} 命中上游熔断，未发出请求`, detail);
      return { httpStatus: 503, body: { code: "UPSTREAM_UNAVAILABLE", message: "上游服务暂不可用（熔断中）" } };
    }
    if (error instanceof UpstreamSessionUnavailableError) {
      logger.error(`workflow-v2 ${action} 会话不可用`, detail);
      return { httpStatus: 503, body: { code: "PLATFORM_SESSION_UNAVAILABLE", message: "平台工作流会话不可用" } };
    }
    const kind = transportFailureKind(error);
    if (kind === "timeout") {
      logger.warn(`workflow-v2 ${action} 上游超时`, detail);
      return { httpStatus: 504, body: { code: "UPSTREAM_TIMEOUT", message: "上游服务响应超时" } };
    }
    if (kind === "network") logger.warn(`workflow-v2 ${action} 上游不可达`, detail);
    // 未预期失败（我方入参错误、配置缺失等）同样按「上游不可用」保守处理：对外只给固定文案，原因进日志。
    else logger.error(`workflow-v2 ${action} 调用失败`, detail);
    return { httpStatus: 502, body: { code: "UPSTREAM_UNAVAILABLE", message: "上游服务不可达" } };
  }

  const code = readPath(outcome.result.body, ["code"]);
  const message = readPath(outcome.result.body, ["msg"]);
  logger.error(`workflow-v2 ${action} 上游失败`, {
    ...context,
    upstreamStatus: outcome.result.status,
    upstreamCode: code,
    upstreamMsg: code === UPSTREAM_PANIC_CODE ? "<panic stack redacted>" : String(message ?? "").slice(0, 200),
  });
  return { httpStatus: 502, body: { code: "UPSTREAM_REJECTED", message: "上游拒绝了本次请求" } };
}

/**
 * 租户绑定不可用时的失败体与状态码：未绑定 → 409（先绑定 App 再建 workflow），降级 → 503（暂时不可用，
 * 可重试；设计 §4.6「写接口直接失败，不做无边界重试」）。
 */
export const bindingFailure = (kind: "not_bound" | "degraded"): HttpFailure =>
  kind === "not_bound"
    ? { httpStatus: 409, body: { code: "ORG_APP_NOT_BOUND", message: "当前组织尚未初始化工作流空间" } }
    : { httpStatus: 503, body: { code: "PLATFORM_ACCOUNT_DEGRADED", message: "平台工作流账号或租户绑定处于降级状态" } };

/** 租户绑定解析结果。 */
export type BindingResolution =
  | { readonly kind: "ready"; readonly binding: TenantBindingSnapshot }
  | { readonly kind: "not_bound" }
  | { readonly kind: "degraded" };

export async function resolveBinding(organizationId: string): Promise<BindingResolution> {
  const binding = await findTenantBinding(organizationId);
  if (!binding) return { kind: "not_bound" };
  if (binding.platformStatus !== "active" || binding.appStatus !== "active") return { kind: "degraded" };
  return { kind: "ready", binding };
}

/**
 * 本地登记失败后的上游补偿：尽力删除刚创建、已无本地归属的上游 workflow。
 *
 * 删除结果不改变响应（本地已记 `pending_cleanup`，对账任务 4A 会重试），但必须留日志：补偿失败意味着上游
 * 存在孤儿 workflow，是告警级事实。
 */
export async function compensateOrphanWorkflow(
  upstream: WorkflowV2UpstreamCall,
  binding: TenantBindingSnapshot,
  context: Record<string, unknown>,
  upstreamWorkflowId: string,
): Promise<void> {
  try {
    const result = await upstream({
      path: "/api/workflow_api/delete",
      body: { workflow_id: upstreamWorkflowId, space_id: binding.platformSpaceId },
    });
    if (isUpstreamDeleteAccepted(result)) {
      logger.warn("workflow-v2 登记失败后已补偿删除上游 workflow", { ...context, upstreamWorkflowId });
      return;
    }
    logger.error("workflow-v2 补偿删除被上游拒绝，留待对账任务重试", {
      ...context,
      upstreamWorkflowId,
      upstreamCode: readPath(result.body, ["code"]),
    });
  } catch (error) {
    logger.error("workflow-v2 补偿删除调用失败，留待对账任务重试", {
      ...context,
      upstreamWorkflowId,
      error: describeError(error),
    });
  }
}
