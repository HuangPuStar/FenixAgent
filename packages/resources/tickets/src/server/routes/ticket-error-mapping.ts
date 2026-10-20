/**
 * 工单错误 → 对外状态的**唯一分类处**（`/web` 与 `/api/system/tickets` 两个面共用）。
 *
 * 为什么分类与信封分开：两个面的判据不同（actor 的受控查询 / 系统 key），信封也不同——`/web` 是
 * `{ success: false, error: { code, message } }`（`web-error.ts`），`/api/system/*` 是
 * `{ error: { code, message } }`（`routes/api/system-error.ts`）。但「哪个错误该给哪个状态码、对外用哪个
 * 稳定码」是同一条业务规则：分两份写，就会出现「同一个 `VERSION_CONFLICT` 在管理面是 409、在控制台是 500」
 * 这类只在某个面复现的缺陷。因此本文件只回答分类问题，信封归各自的面。
 *
 * 映射按「错误自带的 `statusCode` 是否在已声明的状态码集合内」判，而不是逐类 `instanceof`：每个类都把状态
 * 钉死了（`AppError.statusCode` 的语义），逐类列举反而漏掉 `RepositoryOwnerMismatchError`（400，决策 D1 的
 * owner 回读不一致）与 `OperationNotFoundError`（404，决策 D5）这类同表错误。`GitError.WRITE_UNCERTAIN`
 * 刻意不映射：它是「结果未定」，由 Facade 转成 202 分支（§8.3），在这里映射等于把一次可能已生效的写压成失败。
 *
 * 未命中映射表的错误**不在这里抛错也不在这里吞掉**：返回 `undefined` 由调用方原样上抛，交宿主的全局
 * error-handler 兜底 500（`apps/server/src/plugins/error-handler.ts`）——存储故障、装配错误与编程错误不得
 * 被伪装成协议错误。文案边界（§9）：`message` 只透传稳定文案，不回显 token、上游响应体或用户正文。
 */

import { type GitError, isGitError } from "@fenix/git/server";
import { AppError } from "@fenix/platform-sdk";

/**
 * 已映射的错误状态码集合，与两个面的路由 `response` 声明保持一致。
 *
 * 集合外的错误（含 `statusCode` 缺省的 `AppError` 与全部非 `AppError` 异常）原样上抛：给未声明的状态码
 * 返回信封会让响应校验与 OpenAPI 文档同时失真。
 *
 * `403` 在集合里，但管理面**不会**产出它：那一面没有角色判定（凭据即判据），因此管理面的路由不必声明 403。
 * 集合描述的是「哪些状态码属于本模块的对外失败面」，不是「每个面都会出现哪些」。
 */
const MAPPED_ERROR_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 409, 503]);

/**
 * Git 错误码 → 对外状态码；`WRITE_UNCERTAIN` 刻意缺席（见文件头）。
 *
 * 逐个列举而不是按 `kind` 归类是刻意的：`INVALID_REQUEST`（上游**确定拒绝**本次请求，例如附件超出上游
 * 大小上限）与 `UNAVAILABLE`（上游不可用）在 `GitFailureKind` 里同属「确定失败」，但对用户的含义完全不同
 * ——前者要改输入重试（400），后者只能稍后重试（503）。
 */
const GIT_ERROR_STATUS: Partial<Record<GitError["code"], number>> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  // 上游**确定拒绝**本次请求（附件上传的 413/422：超出上游大小上限、扩展名不在白名单）。
  // 它不是「结果未定」：映射成 400 让用户改文件名/换小文件重试，而不是去核对一个从未发生的写入。
  INVALID_REQUEST: 400,
  RATE_LIMITED: 503,
  UNAVAILABLE: 503,
  INVALID_RESPONSE: 503,
};

/** 已分类的对外失败：状态码 + 稳定错误码 + 稳定文案。 */
export interface ClassifiedTicketError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/**
 * 把领域错误分类成对外失败；未列入映射表的返回 `undefined`（调用方原样上抛，交宿主兜底 500）。
 *
 * 入参数类型是 `unknown`：抛出点遍布服务与适配器，调用方拿到的就是一个不透明的异常。
 */
export function classifyTicketError(error: unknown): ClassifiedTicketError | undefined {
  if (isGitError(error)) {
    const status = GIT_ERROR_STATUS[error.code];
    return status === undefined ? undefined : { status, code: error.code, message: error.message };
  }
  if (error instanceof AppError && MAPPED_ERROR_STATUSES.has(error.statusCode)) {
    return { status: error.statusCode, code: error.code, message: error.message };
  }
  return;
}
