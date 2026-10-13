/**
 * Git 失败的分类：把 `@fenix/git` 的错误码收敛成工单侧只需处理的两类情形。
 *
 * 分类**不**在这里决定对外状态码，因为同一个码在不同调用点含义不同：绑定不可用（`FORBIDDEN`/`NOT_FOUND`）
 * 在建工单与开通项目里是**装配/数据故障**，按 §8.3 要报 503 而不是伪装成「工单不存在」的 404；而同一个
 * `NOT_FOUND` 出现在 `issues.create` 的响应里就是真的没有这个仓库对象，报 404 才正确。因此本模块只回答
 * 「这次失败是确定的还是未定的」，映射由调用点按合同条款给出。
 *
 * 两类的分界（`contracts/errors.ts` 的语义边界）：
 * - **确定**：上游已给出结论（含限流与不可达——请求根本没有生效，或明确被拒），调用方可以立刻写失败终态；
 * - **未定**：`WRITE_UNCERTAIN`——写请求超时、连接中断、成功状态但响应体不可解析。远端是否落库**未知**，
 *   既不能报失败也不能重发，只能返回 202 交 T03 按 `message_id` 回源核对。
 *
 * 非 `GitError` 一律返回 undefined：本模块只消化上游的对外失败面，别的异常（编程错误、数据库故障）
 * 必须原样上抛并保持操作行在 `dispatching`，让 T03 的恢复流程去核对（§8.3 步骤 8）。
 */

import { isGitError } from "@fenix/git/server";

/** 分类结论；`definite` 的 `code` 是 Git 侧的原始码，调用点据此选对外错误与状态。 */
export type GitFailureKind =
  | {
      readonly kind: "definite";
      readonly code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "CONFLICT"
        | "UNAVAILABLE"
        | "RATE_LIMITED"
        | "INVALID_RESPONSE"
        // 上游**确定拒绝**本次请求（附件上传的 413/422：超出上游大小上限、扩展名不在白名单）。
        // 它是确定失败而不是未定：绝不能让它进恢复核对去等一个从未发生的写入。
        | "INVALID_REQUEST";
    }
  | { readonly kind: "uncertain" };

/** 上游失败的分类入口；非 `GitError` 返回 undefined（调用方原样上抛、不改状态）。 */
export function classifyGitFailure(error: unknown): GitFailureKind | undefined {
  if (!isGitError(error)) return;
  if (error.code === "WRITE_UNCERTAIN") return { kind: "uncertain" };
  return { kind: "definite", code: error.code };
}
