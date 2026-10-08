import * as Y from "yjs";
import { DEFAULT_PERMISSION_TIMEOUT_MS, type NormalizedEvent } from "../schema";
import { getSessionRoot } from "./chat-writer";
import type { PermissionRequestedHandler } from "./doc-manager";

/** ACP 文本增量的合并窗口；控制事件保持同步投影。 */
export const DEFAULT_BATCH_WINDOW_MS = 16;
export const BATCHABLE_EVENT_TYPES = new Set(["message_delta", "reasoning_delta"]);

function cloneYValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const clone = new Y.Map<unknown>();
    for (const [key, child] of value.entries()) clone.set(key, cloneYValue(child));
    return clone;
  }
  if (value instanceof Y.Array) {
    const clone = new Y.Array<unknown>();
    clone.push(value.toArray().map(cloneYValue));
    return clone;
  }
  return value;
}

/** 投影换代时只保留 Agent 状态与历史列表，避免把旧时间线带入新世代。 */
export function preserveAgentProjection(source: Y.Doc | undefined, target: Y.Doc): void {
  if (!source) return;
  const sourceRoot = source.getMap("root");
  const targetRoot = target.getMap("root");
  target.transact(() => {
    for (const key of ["agent", "sessions", "sessionListLoaded"]) {
      const value = sourceRoot.get(key);
      if (value !== undefined) targetRoot.set(key, cloneYValue(value));
    }
  });
}

/** 归一化用户可见文本（回显去重比较）：折叠空白后 trim。 */
export function normalizeUserText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** 按 blockOrder 拼接 entry 文本，块间分隔防止跨块误匹配。 */
export function readEntryText(entry: Y.Map<unknown>): string {
  const blocks = entry.get("blocks") as Y.Map<Y.Map<unknown>> | undefined;
  const order = entry.get("blockOrder") as Y.Array<string> | undefined;
  if (!blocks || !order) return "";
  return order
    .toArray()
    .map((blockId) => {
      const text = blocks.get(blockId)?.get("text");
      return text instanceof Y.Text ? text.toString() : "";
    })
    .join("\n");
}

/** 读取投影后的权限过期时间，再通知控制面安排超时。 */
export function notifyPermissionRequested(
  handler: PermissionRequestedHandler | null,
  rcsSessionId: string,
  sessionDoc: Y.Doc,
  event: NormalizedEvent,
): void {
  const permissionId =
    (event.update.permissionId as string | undefined) ?? (event.update.requestId as string | undefined);
  if (typeof permissionId !== "string") return;
  const projection = (getSessionRoot(sessionDoc).get("pendingPermissions") as Y.Map<Y.Map<unknown>> | undefined)?.get(
    permissionId,
  );
  const expiresAt =
    (projection?.get("expiresAt") as string | undefined) ??
    (event.update.expiresAt as string | undefined) ??
    new Date(Date.now() + DEFAULT_PERMISSION_TIMEOUT_MS).toISOString();
  handler?.(rcsSessionId, { permissionId, expiresAt });
}
