/**
 * 公共 Git 的稳定错误契约（方案 §5）。
 *
 * 七个错误码是整个模块的对外失败面：适配器把 HTTP 状态、网络故障与解析失败映射到这七个码之一，
 * 上层（工单模块、宿主管理接口）只按码决策，不解读 Forgejo 的响应文本。它们的语义边界是刻意的：
 *
 * - `NOT_FOUND` / `CONFLICT` / `FORBIDDEN`：上游给出的**确定**拒绝，成败已定；
 * - `RATE_LIMITED` / `UNAVAILABLE`：确定失败且可重试（读请求可自动重试，写请求不得自动重放）；
 * - `WRITE_UNCERTAIN`：写请求的超时、连接中断、收到成功响应但返回体无法解析——远端是否落库**未知**，
 *   调用方必须走恢复核对（按 message_id 回源查找），绝不能当作失败直接重发（方案 §9）；
 * - `INVALID_RESPONSE`：上游返回了成功状态但响应体不符合适配器合同（缺字段、类型不符）；读请求可直接
 *   失败，写请求按 `WRITE_UNCERTAIN` 处理，由调用方决定。
 *
 * 错误消息与上下文**不得**携带 token、密钥或请求/响应正文（方案 §5 的日志约束）；`operationId` 是
 * 允许的关联字段，用于把用户可见错误与运维日志串起来。
 */

/** 对外错误码集合；新增码必须同步 `docs/arch/28-common-git.md` 与消费方映射。 */
export const GIT_ERROR_CODES = [
  "NOT_FOUND",
  "FORBIDDEN",
  "CONFLICT",
  "RATE_LIMITED",
  "UNAVAILABLE",
  "WRITE_UNCERTAIN",
  "INVALID_RESPONSE",
] as const;

export type GitErrorCode = (typeof GIT_ERROR_CODES)[number];

/** 构造 GitError 时的可选上下文；只允许放非敏感、可入日志的关联字段。 */
export interface GitErrorOptions {
  readonly cause?: unknown;
  /** 关联 ID：由调用方生成并写入日志，便于把故障串成一条链。 */
  readonly operationId?: string;
  /** 上游 HTTP 状态码（若有）；仅作诊断，不作为决策依据。 */
  readonly status?: number;
}

/** 公共 Git 统一错误类型；`code` 是决策依据。 */
export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly operationId: string | undefined;
  readonly status: number | undefined;

  constructor(code: GitErrorCode, message: string, options: GitErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitError";
    this.code = code;
    this.operationId = options.operationId;
    this.status = options.status;
  }
}

/** 判断任意抛错是否为公共 Git 错误（跨包边界上的收窄入口）。 */
export function isGitError(error: unknown): error is GitError {
  return error instanceof GitError;
}

/**
 * 写操作的错误归一：把「远端是否落库未知」的失败统一提升为 `WRITE_UNCERTAIN`。
 *
 * 只对网络层故障与响应解析失败使用；上游明确返回的 4xx/5xx 是**确定**结果，保持原码——把确定失败
 * 也标成 uncertain 会让恢复流程去核对一个从未发生的写入，把运维噪音当成保护。
 */
export function toWriteUncertain(error: GitError, operationId?: string): GitError {
  if (error.code !== "UNAVAILABLE" && error.code !== "INVALID_RESPONSE") return error;
  return new GitError("WRITE_UNCERTAIN", error.message, {
    cause: error,
    operationId: operationId ?? error.operationId,
    status: error.status,
  });
}
