/**
 * 从会话投影派生交互区所需的只读视图（todo 快照与待处理权限）。
 *
 * 来源：逐字复制 `packages/agent-runtime/web/components/chat/chat-derived-state.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：
 * - `@fenix/chat-channel` 的 `PermissionRequest` 收敛为包内 `../types` 的同构类型（去掉 `@fenix/*` 依赖）。
 * - 移除对宿主 `@/src/lib/tool-semantic` 的 `classifyToolSemantic` 直接依赖，改为调用方注入
 *   `shouldSuppress` 判定；不注入时不再过滤（源实现固定过滤 `ask-user-question`）。
 */

import type { PendingPermission, PermissionRequest, ThreadEntry, TodoItem } from "../types";

/**
 * `derivePendingPermissions` 的可选过滤注入点。
 *
 * 宿主应传入等价于源 `classifyToolSemantic({ name: tool }) === "ask-user-question"` 的判定，
 * 以保持「ask-user-question 由 QuestionPanel 而非 PermissionPanel 处理」的既有分工。
 */
export interface DerivePendingPermissionsOptions {
  /** 返回 true 表示该权限请求由其他面板承接，不应进入待处理权限列表。默认不过滤。 */
  shouldSuppress?: (toolName: string) => boolean;
}

/**
 * 从当前消息投影读取最新的标准 ACP plan 完整快照。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/chat-derived-state.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除）；纯化改动点：无（仅模块路径调整）。
 */
export function deriveTodoItems(entries: ThreadEntry[]): TodoItem[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "plan") continue;
    return entry.entries.map((item) => ({ content: item.content, status: item.status }));
  }
  return [];
}

/**
 * 将 Chat Doc 权限投影转换为交互区域使用的只读视图。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/chat-derived-state.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除）；
 * 纯化改动点：工具语义过滤改由 `options.shouldSuppress` 注入，未注入时保留全部 pending 权限。
 */
export function derivePendingPermissions(
  permissions?: PermissionRequest[],
  options?: DerivePendingPermissionsOptions,
): PendingPermission[] {
  if (!permissions) return [];
  const shouldSuppress = options?.shouldSuppress;
  return permissions
    .filter((permission) => permission.status === "pending" && !shouldSuppress?.(permission.tool))
    .map((permission) => ({
      requestId: permission.id,
      toolName: permission.tool,
      toolInput:
        permission.args && typeof permission.args === "object" ? (permission.args as Record<string, unknown>) : {},
      description: typeof permission.args === "string" ? permission.args : undefined,
      options: permission.options,
    }));
}
