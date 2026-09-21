// 公开错误正文的本地化取值。
//
// 背景：`PublicError.message`（`@fenix/chat-channel/src/public-error.ts`）是 wire 与日志共用字段——
// `isPublicError` 用 `message === PUBLIC_ERROR_MESSAGES[type].en` 校验不可信帧的完整性，服务端
// `createPublicError` 恒取 `.en`。因此界面**不能**读它来显示正文，否则中文界面永远是英文。稳定且
// 有限的是 `type`，本地化文案按 `type` 从本包字典取；`message` 退化为「未登记 type 的兜底 + 日志字段」。
// 取舍与验证见 `docs/design/ce-ee-refactoring/review/task-1.6-web-shell.md` §7.18。
//
// 键不做「type → 键名」映射表：协议 type 自带 `<域>.<原因>` 两段结构，字典按同样两级嵌套组织
// （`chat.components.publicError.AGENT_RUNTIME.REQUEST_FAILED`），键 = 前缀 + type。少一张映射表就少
// 一处会与协议漂移的第二真相；漏键由 `web/__tests__/public-error-text.test.ts` 的穷举断言挡住。

import type { TFunction } from "i18next";

/** 与 `chat.components.*` 下其余卡片文案同级；字典中该子树的两级名字逐字来自协议 type 的两段。 */
const PUBLIC_ERROR_KEY_PREFIX = "chat.components.publicError";

/**
 * 渲染公开错误正文所需的最小形状。
 *
 * 刻意不 import `@fenix/chat-channel` 的 `PublicError`：本包对 chat 契约整体采取「逐字内联」
 * （见 `../internal/types-chat-projection.ts` 的头注），且宿主的 `PublicErrorInfo` 与之结构等价。
 */
export interface PublicErrorTextSource {
  type: string;
  message: string;
}

/**
 * 取公开错误正文的本地化文案。
 *
 * `type` 未登记（协议新增 type 而字典未跟上）时回退 `error.message`——服务端产出的英文安全摘要；
 * 宁可显示英文，也不能让界面出现 `chat.components.publicError.…` 这样的 key 回显。
 */
export function publicErrorText(t: TFunction, error: PublicErrorTextSource): string {
  const key = `${PUBLIC_ERROR_KEY_PREFIX}.${error.type}`;
  const translated = t(key, { defaultValue: error.message });
  // i18next 未命中键时返回 key 本身（`defaultValue` 为空串时不会被采用）；此时明确回到 wire 摘要。
  return translated === key ? error.message : translated;
}
