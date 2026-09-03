import type { PermissionRequest } from "@fenix/chat-channel";
import { classifyToolSemantic } from "../../src/lib/tool-semantic";
import type { PendingPermission, ThreadEntry, TodoItem } from "../../src/lib/types";

/** 从当前消息投影读取最新的标准 ACP plan 完整快照。 */
export function deriveTodoItems(entries: ThreadEntry[]): TodoItem[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "plan") continue;
    return entry.entries.map((item) => ({ content: item.content, status: item.status }));
  }
  return [];
}

/** 将 Chat Doc 权限投影转换为交互区域使用的只读视图。 */
export function derivePendingPermissions(permissions?: PermissionRequest[]): PendingPermission[] {
  if (!permissions) return [];
  return permissions
    .filter(
      (permission) =>
        permission.status === "pending" && classifyToolSemantic({ name: permission.tool }) !== "ask-user-question",
    )
    .map((permission) => ({
      requestId: permission.id,
      toolName: permission.tool,
      toolInput:
        permission.args && typeof permission.args === "object" ? (permission.args as Record<string, unknown>) : {},
      description: typeof permission.args === "string" ? permission.args : undefined,
      options: permission.options,
    }));
}
