// packages/chat-channel/src/state/permission.ts
// 权限 CAS 与收敛（C5）：权限请求的原子迁移与 turn/工具调用关联收敛。
//
// 为什么独立成文件：CAS 迁移（pending → resolved/expired 仅一次）同时被
// 聚合层（permission_resolved / permission_expired 事件）与控制面
// （respond_permission Action、超时定时器）调用，收敛逻辑必须单一来源，
// 否则两处实现漂移会破坏"迁移成功后才发 resolve"的原子语义。
//
// 迁移失败（已 resolved/expired/不存在）返回 false，调用方必须视为
// "未发生副作用"：不得向 Agent 发送 permission.resolve，防止重复授权
// 导致 Agent 执行两遍。

import type * as Y from "yjs";
import {
  getPendingPermissions,
  getToolCallsMap,
  hasPendingPermission,
  readActiveTurn,
  setActiveTurn,
  setToolCallStatus,
} from "./chat-writer";

/** 投影目标：同一 rcsSessionId 的两份 Y.Doc */
export interface DocPair {
  chat: Y.Doc;
  session: Y.Doc;
}

/**
 * 解析权限（CAS）：仅 pending → resolved 迁移一次，成功返回 true。
 * 迁移成功后收敛关联状态：deny → 工具调用 cancelled，allow → 恢复 running；
 * turn 停在 awaiting_permission 且无其他 pending 时恢复 running。
 * 重复 resolve（已 resolved / expired / 不存在）返回 false。
 */
export function applyPermissionResolution(pair: DocPair, permissionId: string, decision: string | null): boolean {
  let migrated = false;
  pair.chat.transact(() => {
    pair.session.transact(() => {
      const permission = getPendingPermissions(pair.session).get(permissionId);
      const status = permission?.get("status");
      // 双重条件：CAS 要求存在且仍为 pending（permission 收窄供后续 set 使用）
      if (status !== "pending" || permission === undefined) return;
      permission.set("status", "resolved");
      migrated = true;

      const toolCallId =
        typeof permission.get("toolCallId") === "string" ? (permission.get("toolCallId") as string) : null;
      if (toolCallId) {
        // deny 语义与 acp-link client.respondToPermission 对齐：optionId 为空（null）即取消；
        // "deny"/"reject" 前缀显式拒绝，其余（allow 等）视为允许
        const denied = decision === null || decision.startsWith("deny") || decision.startsWith("reject");
        setToolCallStatus(pair.chat, toolCallId, denied ? "cancelled" : "running");
      }

      const active = readActiveTurn(pair.session);
      if (active.turnId && active.turnStatus === "awaiting_permission") {
        setActiveTurn(
          pair.session,
          active.turnId,
          hasPendingPermission(pair.session) ? "awaiting_permission" : "running",
        );
      }
    });
  });
  return migrated;
}

/**
 * 过期权限（CAS）：仅 pending → expired 迁移一次，成功返回 true。
 * 迁移成功后收敛关联状态：关联工具调用 → cancelled；turn 停在 awaiting_permission
 * 且无其他 pending 时 → cancelled（文档 8.1：awaiting_permission → cancelled: deny / expiry）。
 * 超时定时器与 permission_expired 事件共用此入口。
 */
export function applyPermissionExpiration(pair: DocPair, permissionId: string): boolean {
  let migrated = false;
  pair.chat.transact(() => {
    pair.session.transact(() => {
      const permission = getPendingPermissions(pair.session).get(permissionId);
      const status = permission?.get("status");
      if (status !== "pending" || permission === undefined) return;
      permission.set("status", "expired");
      migrated = true;

      const toolCallId =
        typeof permission.get("toolCallId") === "string" ? (permission.get("toolCallId") as string) : null;
      if (toolCallId) setToolCallStatus(pair.chat, toolCallId, "cancelled");

      const active = readActiveTurn(pair.session);
      if (active.turnId && active.turnStatus === "awaiting_permission") {
        setActiveTurn(
          pair.session,
          active.turnId,
          hasPendingPermission(pair.session) ? "awaiting_permission" : "cancelled",
        );
      }
    });
  });
  return migrated;
}

/** turn 进入终态时该 turn 的 pending 权限请求失效迁移（expired），不残留 pending 项 */
export function expireTurnPermissions(pair: DocPair, turnId: string): void {
  for (const permission of getPendingPermissions(pair.session).values()) {
    if (permission.get("turnId") !== turnId || permission.get("status") !== "pending") continue;
    permission.set("status", "expired");
  }
}

/** turn 进入终态时仍停留在 awaiting_permission 的工具调用收敛为 cancelled */
export function cancelAwaitingToolCalls(pair: DocPair, turnId: string): void {
  for (const tool of getToolCallsMap(pair.chat).values()) {
    if (tool.get("turnId") !== turnId || tool.get("status") !== "awaiting_permission") continue;
    tool.set("status", "cancelled");
  }
}
