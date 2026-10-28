/**
 * LangBot Service API 的外部 DTO。
 *
 * 这些类型只描述「平台从 LangBot 读到了什么」，不包含 Bot `config`：`config` 可能含平台凭据（如 Telegram
 * token），平台只透传、不落库、不回显，因此连内部投影都不持有它——否则一次日志或一次视图展开就会泄漏。
 *
 * 时间字段保留上游的 ISO 字符串原样：LangBot 的时间格式由 Python 侧决定，平台只做展示，不在边界上
 * 猜测并重新格式化。
 */

/** LangBot 探测结果；`reachable = false` 时其余字段为 null，而不是伪造一个版本号。 */
export interface LangBotStatus {
  readonly reachable: boolean;
  readonly version: string | null;
  readonly edition: string | null;
  readonly wizardStatus: string | null;
}

/** LangBot Bot 的安全投影；刻意不含 `config`。 */
export interface LangBotBot {
  readonly uuid: string;
  readonly name: string;
  readonly adapter: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** 创建请求：`config` 由适配器决定结构，平台只校验「对象且不超过 64 KiB」。 */
export interface CreateLangBotBotInput {
  readonly name: string;
  readonly adapter: string;
  readonly config: Record<string, unknown>;
}

/** 更新请求：字段缺省表示「保持上游原值」，`config` 缺省时不得发送空对象覆盖原配置。 */
export interface UpdateLangBotBotInput {
  readonly name?: string;
  readonly adapter?: string;
  readonly config?: Record<string, unknown>;
}

/** LangBot 的发送目标类型；与 IM 聊天类型同名但语义独立，不要互相赋值。 */
export type LangBotTargetType = "person" | "group";

/** 测试发送请求。 */
export interface LangBotSendMessageInput {
  readonly targetType: LangBotTargetType;
  readonly targetId: string;
  readonly text: string;
  /**
   * 群聊要 @ 的成员；私聊必须省略。
   *
   * 调用方负责校验它来自该会话近期事件（规格 §9.8）；客户端只负责拼进 `message_chain`，不做授权判断。
   */
  readonly mentionUserId?: string | null;
}

/**
 * 从通道 `credentials` 读取 LangBot Bot UUID。
 *
 * `credentials` 是 jsonb 历史字段，读取必须防御非法形状：返回 null 表示「平台行存在但无法定位 Bot」，
 * 由上层按漂移记录处理，而不是抛错阻断整个列表。
 */
export function readBotUuid(credentials: unknown): string | null {
  if (typeof credentials !== "object" || credentials === null) return null;
  const value = (credentials as { botUuid?: unknown }).botUuid;
  return typeof value === "string" && value.length > 0 ? value : null;
}
