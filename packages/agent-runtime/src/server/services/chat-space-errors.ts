import { AppError } from "@fenix/platform-sdk";

/**
 * Chat 会话分组对外暴露的错误词汇表（冻结 API 的一部分）。
 *
 * 为什么要单独一份而不是各层各写：错误码与文案是前端分支的依据，同一含义在多处各写一遍就会漂移
 * （改名撞库、路由换文案、service 与 facade 给出不同的 404 措辞）。这里集中声明，service 与 facade 只引用。
 *
 * 口径：
 * - 状态码与错误码沿用控制面（`routes/web/control.ts`）的小写风格，由路由按 `AppError.statusCode` 映射；
 * - **文案不含任何内部标识**：跨租户存在性不得从错误内容里被探测出来（「实例不存在」与「实例属于别人」
 *   在响应上逐字相同）。
 */

/** 分组名长度上限；与 `chat_space.name` 的列宽、CHECK 约束同值。 */
export const CHAT_SPACE_NAME_MAX_LENGTH = 100;

/** 会话 id 长度上限：ACP 侧 `ses_*` 远短于此，这里只为拦住无界写入（jsonb 列不受列宽约束）。 */
export const CHAT_SPACE_SESSION_ID_MAX_LENGTH = 200;

/** 404：分组不存在，或不在本次请求的 scope 内——两种成因合并，避免用状态码探测他人分组。 */
export function chatSpaceNotFoundError(): AppError {
  return new AppError("Chat space not found", "not_found", 404);
}

/** 404：实例不存在，或不属于当前用户——`getOwnedInstance` 的窄口语义，不区分两种成因。 */
export function instanceNotFoundError(): AppError {
  return new AppError("Agent Instance not found", "not_found", 404);
}

/** 403：实例绑定的环境属于别的组织（组织维度的隔离拒绝）。 */
export function chatSpaceForbiddenError(): AppError {
  return new AppError("Environment does not belong to your organization", "forbidden", 403);
}

/** 400：分组名 trim 后为空或超长。 */
export function chatSpaceNameInvalidError(): AppError {
  return new AppError(`Chat space name must be 1-${CHAT_SPACE_NAME_MAX_LENGTH} characters`, "invalid_name", 400);
}

/** 400：会话 id 为空或超长。 */
export function invalidSessionIdError(): AppError {
  return new AppError("Invalid session id", "invalid_session_id", 400);
}

/** 409：同 scope 下已存在同名分组（由唯一索引裁决，并发创建/改名同样落到这里）。 */
export function chatSpaceNameConflictError(): AppError {
  return new AppError("Chat space name already exists", "name_conflict", 409);
}
