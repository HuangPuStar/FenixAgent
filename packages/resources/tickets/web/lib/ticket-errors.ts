/**
 * 工单失败分类：把「无权限 / 不存在 / 冲突 / 待确认」从通用失败里分出来。
 *
 * **这是仓内第 5 份 `isUnauthorizedError` 副本**（既有四份：`@fenix/resource-mcp`、
 * `@fenix/resource-plugin-market`、`@fenix/resource-task`、`@fenix/resource-workflow-v2`）。
 * `@fenix/web-runtime` 今天没有承载这类判定的出口，故按前端规范 §4.1「抽象延迟到第二个真实用例」的反面
 * ——用例已足够多——仍不在此批新建跨包契约：下沉它要同时改五个包的 import 与各自的用例，属独立重构，
 * 与本批目标（工单功能）无关。
 *
 * **下沉触发条件的现状（T03 登记）**：文件头原定的触发条件「需要按错误码做除『有没有权限』以外的判别」
 * 本批已满足（要判 `VERSION_CONFLICT` / `IDEMPOTENCY_CONFLICT` / `TICKET_OPERATION_PENDING`），但裁定
 * 三.13 决定**本批不下沉**：通用分类（401/403/404/503）与工单协议码是两回事，后者即便将来下沉也应当
 * 留在本包。因此「把通用分类收敛到 `@fenix/web-runtime/api/error-classify`」另立任务，本包只留消费侧。
 */

import { ApiError } from "@fenix/web-runtime/api/request";

/**
 * 无权限码。两个都要认：`UNAUTHORIZED` 是 `request()` 在响应体没有 code 时对 401/403 的归一值，
 * `FORBIDDEN` 是服务端 `ForbiddenError` 透传的业务码（`request()` 只在无 code 时才按 HTTP 状态归一，
 * 因此不能只看状态码）。
 */
const UNAUTHORIZED_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "UNAUTHORIZED"]);

/**
 * 判断失败是否属「无权限」。授权是持久状态，重试只会再拿一个 403，因此调用方对它**只展示原因、不给重试**；
 * 其余失败（网络、5xx、503 暂停）必须保留重试入口。
 */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && UNAUTHORIZED_CODES.has(error.code);
}

/** 判断失败是否「工单不存在或无权访问」（服务端对跨组织资源返回 404，与不存在同形）。 */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "NOT_FOUND";
}

/**
 * 409 内容版本冲突：读取与提交之间对象被改过，必须基于最新内容重新提交。
 *
 * 与服务端的一致口径是**回源内容指纹**（不是索引版本），因此界面上的动作是「加载最新内容」而不是
 * 无脑重试——重试只会带着同一个过期版本再拿一次 409。
 */
export function isVersionConflictError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "VERSION_CONFLICT";
}

/**
 * 409 幂等冲突：同一把键被用于不同内容。正常流程不该出现（出现即说明签名漏了请求体字段），
 * 处置是换代后重试——继续复用旧键只会一直撞同一堵墙。
 */
export function isIdempotencyConflictError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "IDEMPOTENCY_CONFLICT";
}

/**
 * 409 未确认变更：同一对象上已有一笔未终结的写（含 `uncertain` / `needs_review`），本次修改被拒绝。
 *
 * 这是「未确认变更阻止后续修改」的**竞态兜底**：服务端还会在详情视图里返回 `pendingOperationId`，
 * 正常情况下界面凭它就能提前禁用写入口；此码用于两个标签页互不知情、或状态刚被他人改变的窗口期。
 */
export function isOperationPendingError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "TICKET_OPERATION_PENDING";
}
