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
import { convergeTurnExit } from "./turn-machine";

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
 *
 * 归属校验：权限按 permission.turnId 收敛，仅当该 turn 仍是 active 时才允许
 * 恢复/退出 turn 状态机——旧 turn 的迟到决议不得污染恰好停在 awaiting_permission
 * 的新 turn（跨 turn 污染是权限相关 bug 的反复根因）。
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
      // 条目级 deny 判定与 acp-link client.respondToPermission 对齐：optionId 为空（null）即取消；
      // "deny"/"reject" 前缀显式拒绝，其余（allow 等）视为允许
      const denied = decision === null || decision.startsWith("deny") || decision.startsWith("reject");
      // decision 落盘供前端展示（expired 路径不写，保持 null）
      permission.set("decision", denied ? "deny" : "allow");
      migrated = true;

      const permissionTurnId =
        typeof permission.get("turnId") === "string" ? (permission.get("turnId") as string) : null;
      const toolCallId =
        typeof permission.get("toolCallId") === "string" ? (permission.get("toolCallId") as string) : null;
      if (toolCallId) {
        const tool = getToolCallsMap(pair.chat).get(toolCallId);
        // 工具归属校验（tool.turnId === permission.turnId）：跨 turn 迟到决议
        // 只收敛自己关联的工具，不触碰其他 turn 的工具状态
        if (tool && tool.get("turnId") === permissionTurnId) {
          setToolCallStatus(pair.chat, toolCallId, denied ? "cancelled" : "running");
        }
      }

      const active = readActiveTurn(pair.session);
      // turn 状态机恢复仅限权限所属 turn 与 active 一致时
      if (
        permissionTurnId !== null &&
        active.turnId === permissionTurnId &&
        active.turnStatus === "awaiting_permission"
      ) {
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
 *
 * 归属校验同 applyPermissionResolution：跨 turn 迟到过期不得污染新 turn；
 * turn 因权限全部失效而退出时经 convergeTurnExit 统一收敛（entry 一并置 cancelled，
 * 否则 assistant entry 永久 streaming）。
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

      const permissionTurnId =
        typeof permission.get("turnId") === "string" ? (permission.get("turnId") as string) : null;
      const toolCallId =
        typeof permission.get("toolCallId") === "string" ? (permission.get("toolCallId") as string) : null;
      if (toolCallId) {
        const tool = getToolCallsMap(pair.chat).get(toolCallId);
        if (tool && tool.get("turnId") === permissionTurnId) {
          setToolCallStatus(pair.chat, toolCallId, "cancelled");
        }
      }

      const active = readActiveTurn(pair.session);
      if (
        permissionTurnId !== null &&
        active.turnId === permissionTurnId &&
        active.turnStatus === "awaiting_permission"
      ) {
        if (hasPendingPermission(pair.session)) {
          setActiveTurn(pair.session, active.turnId, "awaiting_permission");
        } else {
          // 该 turn 的权限全部失效 → turn 退出：经统一收敛入口终结 entry
          convergeTurnExit(pair, active.turnId, {
            entryStatus: "cancelled",
            finalStatus: "cancelled",
          });
        }
      }
    });
  });
  return migrated;
}
