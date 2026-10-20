// packages/chat-channel/src/sync/protocol/errors.ts
// 同步协议的稳定错误码与错误类型。
//
// 分层边界（不得合并）：本表是**同步协议内部码**，只服务于 `sync/` 内部模块之间的失败分类、
// 重试判定与 ERROR 帧的机器可读字段；`src/public-error.ts` 的 `PUBLIC_ERROR_TYPES` 是
// **浏览器安全注册表**，面向前端展示与日志脱敏。二者不是同一层：协议内部码随实现演进
// （新增、替换、下线），公开注册表是对外承诺，把内部码并进去等于把实现细节固化成契约，
// 还会让前端可见面被同步实现细节污染。协议码 → 公开类型的映射在接线阶段（E）按最小暴露面
// 单独实现，本文件不做映射。

/** 同步协议错误码：稳定、机器可读，只允许出现在 `sync/` 内部与 ERROR 帧。 */
export const SYNC_ERROR_CODES = [
  "PROTOCOL_VERSION_UNSUPPORTED",
  "MALFORMED_FRAME",
  "FRAME_TOO_LARGE",
  "FRAME_HEADER_TOO_LARGE",
  "IDENTIFIER_TOO_LONG",
  "GENERATION_MISMATCH",
  "GENERATION_NOT_CURRENT",
  "POINTER_REVISION_STALE",
  "SUBSCRIPTION_EPOCH_STALE",
  "SYNC_ATTEMPT_STALE",
  "TRANSPORT_EPOCH_STALE",
  "DELIVERY_DUPLICATE",
  "DOC_NOT_FOUND",
  "DOC_STALE_REFERENCE",
  "SEQUENCE_GAP",
  "DIGEST_CONFLICT",
  "COMMIT_OUTCOME_UNKNOWN",
  "WRITER_EPOCH_LOST",
  "LEASE_EXPIRED",
  "SCOPE_BUSY",
  "CAPACITY_EXCEEDED",
  "ADMISSION_REJECTED",
  "STAGING_FAILED",
  "IMPORT_INCOMPLETE",
  "BINDING_UNKNOWN",
  "RESOURCE_RETIRED",
  "DUPLICATE_OBJECT",
] as const;

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

/**
 * 可重试判定：`true` 只表示「同一请求在退避后重试有成功可能」，不代表不限次重试。
 *
 * 判为可重试的码：
 * - `COMMIT_OUTCOME_UNKNOWN`：提交结果未知，按同键幂等重试由存储确认真实结局；
 * - `SCOPE_BUSY`、`CAPACITY_EXCEEDED`、`ADMISSION_REJECTED`：瞬态并发或过载，不排队不等待，
 *   退避后重试（`ADMISSION_REJECTED` 也用于容量配置校验失败这类永久错误，但那只在启用期抛出，
 *   不会作为帧错误发给客户端，故客户端侧默认取瞬态语义）；
 * - `STAGING_FAILED`：导入中途失败，保留旧 generation 后用新 loadId 重试；
 * - `BINDING_UNKNOWN`：绑定尚未建立，重连后可解析。
 *
 * 其余码不得重试，且必须逐条显式列出——新增错误码时编译器会强制在此处分类：
 * - 结构性输入错误（`PROTOCOL_VERSION_UNSUPPORTED`、`MALFORMED_FRAME`、`FRAME_TOO_LARGE`、
 *   `FRAME_HEADER_TOO_LARGE`、`IDENTIFIER_TOO_LONG`）：重试不会改变输入；
 * - 代次/版本/序号冲突（`GENERATION_MISMATCH`、`GENERATION_NOT_CURRENT`、
 *   `POINTER_REVISION_STALE`、`SUBSCRIPTION_EPOCH_STALE`、`SYNC_ATTEMPT_STALE`、
 *   `TRANSPORT_EPOCH_STALE`、`SEQUENCE_GAP`、`DIGEST_CONFLICT`、`DOC_STALE_REFERENCE`、
 *   `DUPLICATE_OBJECT`、`IMPORT_INCOMPLETE`）：必须重新握手或重读已提交边界，属于换新计划；
 * - 写者身份或资源失效（`WRITER_EPOCH_LOST`、`LEASE_EXPIRED`、`DOC_NOT_FOUND`、
 *   `RESOURCE_RETIRED`）：沿旧 epoch 重试必然再失败，必须先重新取得租约或资源；
 * - 已生效的重复投递（`DELIVERY_DUPLICATE`）：按账本确认一次即可，重试无意义。
 */
export function isRetryableSyncErrorCode(code: SyncErrorCode): boolean {
  switch (code) {
    case "COMMIT_OUTCOME_UNKNOWN":
    case "SCOPE_BUSY":
    case "CAPACITY_EXCEEDED":
    case "ADMISSION_REJECTED":
    case "STAGING_FAILED":
    case "BINDING_UNKNOWN":
      return true;
    case "PROTOCOL_VERSION_UNSUPPORTED":
    case "MALFORMED_FRAME":
    case "FRAME_TOO_LARGE":
    case "FRAME_HEADER_TOO_LARGE":
    case "IDENTIFIER_TOO_LONG":
    case "GENERATION_MISMATCH":
    case "GENERATION_NOT_CURRENT":
    case "POINTER_REVISION_STALE":
    case "SUBSCRIPTION_EPOCH_STALE":
    case "SYNC_ATTEMPT_STALE":
    case "TRANSPORT_EPOCH_STALE":
    case "DELIVERY_DUPLICATE":
    case "DOC_NOT_FOUND":
    case "DOC_STALE_REFERENCE":
    case "SEQUENCE_GAP":
    case "DIGEST_CONFLICT":
    case "WRITER_EPOCH_LOST":
    case "LEASE_EXPIRED":
    case "IMPORT_INCOMPLETE":
    case "RESOURCE_RETIRED":
    case "DUPLICATE_OBJECT":
      return false;
    default: {
      // 穷举兜底：新增错误码若未在上方显式分类，此处会因 `never` 赋值失败而编译不过。
      const unclassified: never = code;
      return unclassified;
    }
  }
}

/**
 * 允许进入 ERROR 帧、日志与 `safeContext` 的字段集合。
 *
 * `scope` 使用 `scopeKey()` 产出的归一化字符串；本结构禁止承载对话正文、工具参数、
 * 认证 token、文件路径或任何客户端可控的自由文本（它们可能被原样回传给对端并落盘）。
 */
export interface SyncSafeContext {
  scope?: string;
  generation?: string;
  docId?: string;
  seq?: number;
  ordinal?: number;
}

/** `SyncProtocolError` 的可选构造参数。 */
export interface SyncProtocolErrorOptions {
  /** 覆盖按码推导的 `retryable`；只在调用方有更强证据（如已确认过载）时使用。 */
  retryable?: boolean;
  /** 安全上下文；缺省为空对象，绝不自动携带异常原始文本。 */
  safeContext?: SyncSafeContext;
  /**
   * 人类可读说明，禁止携带正文或凭据；默认只含错误码。
   * 长度不在本层截断（静默截断会掩盖越界用法），由 ERROR 帧的 schema 在编码时拒绝超限。
   */
  message?: string;
  /** 原始异常，仅用于本地诊断与日志，不进入 ERROR 帧。 */
  cause?: unknown;
}

/** 同步协议层的唯一异常类型：稳定错误码 + 安全上下文 + 可重试判定。 */
export class SyncProtocolError extends Error {
  readonly code: SyncErrorCode;
  readonly retryable: boolean;
  readonly safeContext: SyncSafeContext;

  constructor(code: SyncErrorCode, options: SyncProtocolErrorOptions = {}) {
    super(options.message ?? `sync protocol error: ${code}`, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "SyncProtocolError";
    this.code = code;
    this.retryable = options.retryable ?? isRetryableSyncErrorCode(code);
    this.safeContext = options.safeContext ?? {};
    // `cause` 由 Error 承载（`Error.cause`），此处不重复声明字段：重声明的类字段会在
    // ES2022 类字段语义下把 super 已写入的 cause 覆盖成 undefined。
  }

  /** 供 ERROR 帧使用的安全上下文浅拷贝：消费方改写不得影响错误对象本身。 */
  toFrameContext(): SyncSafeContext {
    return { ...this.safeContext };
  }
}

/**
 * 归一化未知异常：已是本层错误时原样返回（保留 code、retryable、safeContext），
 * 其它异常按 `fallbackCode` 包装并把原始异常挂到 `cause`。
 *
 * 刻意不复制原始 `error.message`：上游异常文本可能携带正文、文件路径或凭据，
 * 而本错误对象会被序列化进 ERROR 帧。诊断信息经 `cause` 保留，由日志侧的脱敏出口呈现。
 */
export function asSyncProtocolError(error: unknown, fallbackCode: SyncErrorCode): SyncProtocolError {
  if (error instanceof SyncProtocolError) {
    return error;
  }
  return new SyncProtocolError(fallbackCode, { cause: error });
}
