// web/__tests__/ticket-errors.test.ts
// 工单失败分类的契约：错误码字面量是**工单协议知识**，写错一位不会让任何断言变红，界面却会静默降级
// （把版本冲突显示成「更新失败」并让用户无脑重试，只会再拿一次 409；把 404 当成可重试会把用户困在
// 一个注定失败的按钮上）。因此这里逐码钉住「哪个分类函数认哪个码」。
//
// 分类函数只做 `ApiError.code` 比对，不依赖 DOM、不发请求，因此不需要渲染环境。

import { describe, expect, test } from "bun:test";

import { ApiError } from "@fenix/web-runtime/api/request";

import {
  isIdempotencyConflictError,
  isNotFoundError,
  isOperationPendingError,
  isUnauthorizedError,
  isVersionConflictError,
} from "../lib/ticket-errors";

/** 构造带业务码的失败（`request()` 在响应体带 code 时原样透传该码）。 */
function apiError(code: string): ApiError {
  return new ApiError("boom", code);
}

describe("工单失败分类", () => {
  // 无权限要认两个码：`FORBIDDEN` 是服务端透传的业务码，`UNAUTHORIZED` 是响应体没有 code 时按 401/403
  // 的归一值。只认一个会让另一半请求显示出「重试」按钮，而重试只会再拿一次同样的状态码。
  test("403 的两种码都判为无权限，其余码不误判", () => {
    expect(isUnauthorizedError(apiError("FORBIDDEN"))).toBe(true);
    expect(isUnauthorizedError(apiError("UNAUTHORIZED"))).toBe(true);
    expect(isUnauthorizedError(apiError("NOT_FOUND"))).toBe(false);
    expect(isUnauthorizedError(new Error("boom"))).toBe(false);
  });

  // 跨组织资源与不存在同形返回 404：这类失败要给「不存在」的持久结论，不能给重试。
  test("NOT_FOUND 判为不存在，网络错误不误判", () => {
    expect(isNotFoundError(apiError("NOT_FOUND"))).toBe(true);
    expect(isNotFoundError(apiError("NETWORK_ERROR"))).toBe(false);
  });

  // 版本冲突的动作是「加载最新内容」而不是原样重试：重试只会带着同一个过期版本再撞一次 409。
  // 它与幂等冲突是两种不同的处置（前者刷新后重提、后者换代），因此必须能分开判。
  test("VERSION_CONFLICT 判为版本冲突且不与幂等冲突混同", () => {
    expect(isVersionConflictError(apiError("VERSION_CONFLICT"))).toBe(true);
    expect(isVersionConflictError(apiError("IDEMPOTENCY_CONFLICT"))).toBe(false);
  });

  // 幂等冲突说明签名与请求体不一致（前端 bug）：换代后重试，继续复用旧键只会一直撞同一堵墙。
  test("IDEMPOTENCY_CONFLICT 判为幂等冲突", () => {
    expect(isIdempotencyConflictError(apiError("IDEMPOTENCY_CONFLICT"))).toBe(true);
    expect(isIdempotencyConflictError(apiError("VERSION_CONFLICT"))).toBe(false);
  });

  // 在途互斥是「未确认变更阻止后续修改」的竞态兜底（正常情况下界面凭 `pendingOperationId` 就禁用了
  // 写入口）：认不出它，用户会看到一条与什么都对不上的「更新失败」提示。
  test("TICKET_OPERATION_PENDING 判为未确认变更，VERSION_CONFLICT 不误判", () => {
    expect(isOperationPendingError(apiError("TICKET_OPERATION_PENDING"))).toBe(true);
    expect(isOperationPendingError(apiError("VERSION_CONFLICT"))).toBe(false);
  });
});
