// 公开错误的唯一稳定注册表。保持浏览器安全：不得引入 Node-only 模块。

export const PUBLIC_ERROR_TYPES = [
  "AGENT_RUNTIME.REQUEST_FAILED",
  "AGENT_RUNTIME.SESSION_FAILED",
  "AGENT_RUNTIME.PROMPT_REJECTED",
  "AGENT_RUNTIME.PROMPT_TIMEOUT",
  "AGENT_RUNTIME.DISCONNECTED",
  "SYNC_RELAY.CONNECTION_LOST",
  "SYNC_RELAY.CAPACITY_EXCEEDED",
  "SYNC_RELAY.KEEPALIVE_TIMEOUT",
  "SYNC_RELAY.SYNC_FAILED",
  "CONTROL_PLANE.ENVIRONMENT_UNAVAILABLE",
  "CONTROL_PLANE.MACHINE_UNAVAILABLE",
  "CONTROL_PLANE.INSTANCE_RECLAIMED",
  "CONTROL_PLANE.INSTANCE_START_FAILED",
  "CONTROL_PLANE.INSTANCE_LIMIT_REACHED",
  "CONTROL_PLANE.CONFIGURATION_INVALID",
  "ACTION.UNAUTHENTICATED",
  "ACTION.FORBIDDEN",
  "ACTION.SESSION_NOT_FOUND",
  "ACTION.VERSION_CONFLICT",
  "ACTION.INVALID_STATE",
  "ACTION.RATE_LIMITED",
  "ACTION.PAYLOAD_TOO_LARGE",
  "ACTION.AGENT_UNAVAILABLE",
  "ACTION.FAILED",
  "INTERNAL.UNCLASSIFIED",
] as const;

export type PublicErrorType = (typeof PUBLIC_ERROR_TYPES)[number];

export interface PublicError {
  /** 稳定、有限、下游不得改写的公开错误类型。 */
  type: PublicErrorType;
  /** 至少包含 128 bit CSPRNG 随机性的公开诊断标识。 */
  id: string;
  /** 由本注册表产生的安全摘要，不得使用原始异常文本。 */
  message: string;
}

/** 将公开错误序列化为低敏、可解析的统一诊断事件。 */
export function serializePublicErrorLog(error: PublicError, stage: string): string {
  return JSON.stringify({
    event: "chat.error",
    errorId: error.id,
    errorType: error.type,
    stage,
    occurredAt: new Date().toISOString(),
  });
}

export interface PublicErrorMessages {
  zh: string;
  en: string;
}

export const PUBLIC_ERROR_MESSAGES: Readonly<Record<PublicErrorType, PublicErrorMessages>> = {
  "AGENT_RUNTIME.REQUEST_FAILED": { zh: "Agent 请求失败。", en: "The Agent request failed." },
  "AGENT_RUNTIME.SESSION_FAILED": { zh: "Agent 会话失败。", en: "The Agent session failed." },
  "AGENT_RUNTIME.PROMPT_REJECTED": { zh: "Agent 拒绝了请求。", en: "The Agent rejected the request." },
  "AGENT_RUNTIME.PROMPT_TIMEOUT": { zh: "Agent 请求处理超时。", en: "The Agent request timed out." },
  "AGENT_RUNTIME.DISCONNECTED": { zh: "Agent 连接已断开。", en: "The Agent disconnected." },
  "SYNC_RELAY.CONNECTION_LOST": { zh: "同步连接已断开。", en: "The synchronization connection was lost." },
  "SYNC_RELAY.CAPACITY_EXCEEDED": {
    zh: "同步服务当前无法接受更多连接。",
    en: "The synchronization service cannot accept more connections.",
  },
  "SYNC_RELAY.KEEPALIVE_TIMEOUT": { zh: "同步连接保活超时。", en: "The synchronization connection timed out." },
  "SYNC_RELAY.SYNC_FAILED": { zh: "同步失败。", en: "Synchronization failed." },
  "CONTROL_PLANE.ENVIRONMENT_UNAVAILABLE": { zh: "Agent 环境不可用。", en: "The Agent environment is unavailable." },
  "CONTROL_PLANE.MACHINE_UNAVAILABLE": { zh: "Agent 运行机器当前不可用。", en: "The Agent machine is unavailable." },
  "CONTROL_PLANE.INSTANCE_RECLAIMED": { zh: "Agent 实例已被回收。", en: "The Agent instance was reclaimed." },
  "CONTROL_PLANE.INSTANCE_START_FAILED": { zh: "Agent 实例启动失败。", en: "The Agent instance failed to start." },
  "CONTROL_PLANE.INSTANCE_LIMIT_REACHED": {
    zh: "Agent 实例数量已达上限。",
    en: "The Agent instance limit was reached.",
  },
  "CONTROL_PLANE.CONFIGURATION_INVALID": { zh: "Agent 配置无效。", en: "The Agent configuration is invalid." },
  "ACTION.UNAUTHENTICATED": { zh: "当前操作需要认证。", en: "The action requires authentication." },
  "ACTION.FORBIDDEN": { zh: "当前操作未获授权。", en: "The action is not authorized." },
  "ACTION.SESSION_NOT_FOUND": { zh: "操作对应的会话不存在。", en: "The action session was not found." },
  "ACTION.VERSION_CONFLICT": { zh: "操作状态版本冲突。", en: "The action state version conflicted." },
  "ACTION.INVALID_STATE": { zh: "当前状态不允许执行该操作。", en: "The action is invalid in the current state." },
  "ACTION.RATE_LIMITED": { zh: "当前操作请求过多。", en: "Too many actions were submitted." },
  "ACTION.PAYLOAD_TOO_LARGE": { zh: "操作数据过大。", en: "The action payload is too large." },
  "ACTION.AGENT_UNAVAILABLE": { zh: "Agent 当前不可用于该操作。", en: "The Agent is unavailable for the action." },
  "ACTION.FAILED": { zh: "操作失败。", en: "The action failed." },
  "INTERNAL.UNCLASSIFIED": { zh: "系统发生未分类错误。", en: "An unclassified system error occurred." },
};

const PUBLIC_ERROR_TYPE_SET: ReadonlySet<string> = new Set(PUBLIC_ERROR_TYPES);
const ERROR_ID_PATTERN = /^err_[0-9a-f]{32}$/;

/** 判断未知值是否为注册表中的稳定公开 Type。 */
export function isPublicErrorType(value: unknown): value is PublicErrorType {
  return typeof value === "string" && PUBLIC_ERROR_TYPE_SET.has(value);
}

/** 严格校验跨 transport / Y.Doc 边界的完整公开错误。 */
export function isPublicError(value: unknown): value is PublicError {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isPublicErrorType(record.type) &&
    typeof record.id === "string" &&
    ERROR_ID_PATTERN.test(record.id) &&
    typeof record.message === "string" &&
    record.message === PUBLIC_ERROR_MESSAGES[record.type].en
  );
}

/** 在首次确认公开故障的服务端边界生成错误；下游只能传递返回值。 */
export function createPublicError(type: PublicErrorType): PublicError {
  const safeType = isPublicErrorType(type) ? type : "INTERNAL.UNCLASSIFIED";
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { type: safeType, id: `err_${random}`, message: PUBLIC_ERROR_MESSAGES[safeType].en };
}
