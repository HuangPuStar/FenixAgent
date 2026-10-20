import * as Y from "yjs";
import { DEFAULT_PERMISSION_TIMEOUT_MS, type NormalizedEvent } from "../schema";
import type { ChatDoc } from "../types";
import { getEntriesMap, getEntryOrder, getSessionRoot, isCallbackEntryId } from "./chat-writer";
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

/**
 * 用户消息写入前的代次复核。
 *
 * 跨进程换代后本地 Doc 仍是旧代次，消息写进去只会在本地重载时被丢弃，而用户已收到成功回执。
 * 只对用户消息做一次 Redis 复核（低频且用户可感知）；ACP 增量与广播保持每帧零 Redis。
 * Redis 故障由 `isGenerationCurrent` 按可用性放行，恢复后由连接层 watcher 收敛。
 */
export async function scheduleUserMessageWrite(input: {
  readonly redisPresent: boolean;
  readonly doc: ChatDoc | undefined;
  readonly currentDoc: () => ChatDoc | undefined;
  readonly isGenerationCurrent: (generation: string) => Promise<boolean>;
  readonly write: () => void;
  readonly onDropped: () => void;
  readonly onError?: (error: unknown) => void;
}): Promise<void> {
  const doc = input.doc;
  if (!input.redisPresent || doc === undefined) {
    input.write();
    return;
  }
  await input
    .isGenerationCurrent(doc.generation)
    .then((current) => {
      if (!current) {
        input.onDropped();
        return;
      }
      // 复核 await 窗口内可能已换代：这条消息属于旧 ACP 会话，不能写进新投影。
      if (input.currentDoc() !== doc) return;
      input.write();
    })
    .catch((error: unknown) => input.onError?.(error));
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

/**
 * 文档中是否已存在同文本的 user entry（实时回显 / 重复回放的去重判定）。
 *
 * 用途：窗口外无 turnId 的 user_message（relay 的 callback 分类）需要区分
 * 「实时 prompt 回显 / 迟到历史回放」与「真异步回调」。回显的文本必然已由
 * `registerUserMessage` 写入 Chat Doc，命中即回显/重复回放；未命中视为回调。
 *
 * 匹配集合排除 callback_* 条目：它们同样是 role=user，但不是 `registerUserMessage`
 * 写的（是回调自己的提问气泡）。纳入匹配会让周期性重复同一提示词的真回调命中上
 * 一次回调的条目，提问与回答整条被静默丢弃——数据丢失比错位更糟，故回调条目
 * 一律不参与回显去重。
 *
 * 归一化口径：trim + 折叠空白——引擎回显可能改写空白，逐字比较会漏判；
 * 空文本一律返回 false（不得把空回显当"已有内容"，否则真回调会被吞）。
 * 复杂度 O(entry 数)，每条回显帧一次调用，无需缓存（条目量级放大时再加窗口）。
 */
export function hasUserMessageTextInDoc(ydoc: Y.Doc, text: string): boolean {
  const target = normalizeUserText(text);
  if (!target) return false;
  const entries = getEntriesMap(ydoc);
  for (const entryId of getEntryOrder(ydoc).toArray()) {
    if (isCallbackEntryId(entryId)) continue;
    const entry = entries.get(entryId);
    if (entry?.get("role") !== "user") continue;
    if (normalizeUserText(readEntryText(entry)) === target) return true;
  }
  return false;
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
