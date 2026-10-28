/**
 * Channel 控制面共享契约。
 *
 * 错误码是 `/web` 响应体的一部分，因此集中定义；Facade 抛出结构化错误，路由只负责状态码与信封映射。
 * 错误文案不得包含 LangBot 响应体、API Key、Bot config 或连接 token。
 */

/** 控制面对外错误码；新增一个码时必须同时给出稳定的 HTTP 状态语义。 */
export type ChannelControlErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "ROUTE_CONFLICT"
  | "AGENT_CONFIG_UNAVAILABLE"
  | "LANGBOT_NOT_CONFIGURED"
  | "LANGBOT_UNREACHABLE"
  | "LANGBOT_UNAUTHORIZED"
  | "LANGBOT_BOT_NOT_FOUND"
  | "LANGBOT_REJECTED"
  | "LANGBOT_BAD_RESPONSE"
  | "SEND_FAILED"
  | "CHANNEL_PERSIST_FAILED"
  | "INTERNAL_ERROR";

/** 门面抛出的结构化错误；`status` 是 `/web` 协议层使用的 HTTP 状态码。 */
export class ChannelControlError extends Error {
  readonly code: ChannelControlErrorCode;
  readonly status: number;
  /**
   * 调用方能否安全重试。
   *
   * 由产生错误的一侧判定：只有上游 5xx、429 与连接失败为 true；参数错误、鉴权失败、业务拒绝与响应解析
   * 失败都为 false——重试它们只会重复同一次失败。默认 false，避免消费方靠 `status` 猜语义。
   */
  readonly retryable: boolean;

  constructor(
    code: ChannelControlErrorCode,
    status: number,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message, options);
    this.name = "ChannelControlError";
    this.code = code;
    this.status = status;
    this.retryable = options?.retryable ?? false;
  }
}

/** 已由门面归一化的成功结果；`status` 只用于 201 这类非 200 的成功响应。 */
export interface ChannelActionResult<T> {
  readonly status: number;
  readonly data: T;
}
