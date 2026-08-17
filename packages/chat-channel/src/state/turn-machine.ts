// packages/chat-channel/src/state/turn-machine.ts
// turn 退出收敛（唯一权威入口）：「turn 离开活动态」必须同时收敛
// assistant entry / pendingPermissions / 该 turn 全部工具调用。
//
// 历史教训：同一语义曾分裂在三个入口（终态事件 / 权限全部失效 / 用户连发），
// 每处只收敛一部分——权限残留 pending、running 工具永久转圈、assistant entry
// 不置终态（前端永远 streaming）。任何新的收敛项只允许加在本文件，
// 调用方不得自行手写收敛逻辑。

import type { PublicError, TurnStatus } from "../schema";
import {
  getEntry,
  getPendingPermissions,
  getToolCallsMap,
  readActiveTurn,
  setActiveTurn,
  setEntryStatus,
  setEntryTokenUsage,
} from "./chat-writer";
import type { DocPair } from "./permission";

/** turn 内 assistant entry 的 id 推导（与聚合层 applyUserMessage 的 ASSISTANT_ENTRY 一致） */
export function turnAssistantEntryId(turnId: string): string {
  return `${turnId}:assistant`;
}

export interface TurnExitOptions {
  /** turn 状态机终态（null = 仅收敛挂起项，如用户连发时新 turn 已接管 activeTurn） */
  finalStatus?: Extract<TurnStatus, "completed" | "cancelled" | "interrupted" | "failed">;
  /** assistant entry 的展示终态（回放收敛用 completed，实时取消用 cancelled） */
  entryStatus?: "completed" | "cancelled" | "error";
  /** 终态事件附带的元数据（error 仅在非空时写入；usage 仅 completed 事件携带，null 不写） */
  meta?: { error?: PublicError | null; usage?: Record<string, unknown> | null };
}

/**
 * 统一收敛「turn 离开活动态」：assistant entry 终态 + 权限失效迁移 + 工具收敛。
 * 幂等：entry 不存在 / 权限已非 pending / 工具已终态时各自 no-op，可重复调用。
 */
export function convergeTurnExit(pair: DocPair, turnId: string, opts: TurnExitOptions): void {
  const entryId = turnAssistantEntryId(turnId);
  const entry = getEntry(pair.chat, entryId);
  if (entry) {
    if (opts.entryStatus) setEntryStatus(pair.chat, entryId, opts.entryStatus);
    if (opts.meta?.error) entry.set("error", opts.meta.error);
    if (opts.meta?.usage) setEntryTokenUsage(pair.chat, entryId, opts.meta.usage);
  }
  // finalStatus 仅在 turnId 仍是 active 时写入：用户连发场景新 turn 已接管，不得回退
  if (opts.finalStatus) {
    const active = readActiveTurn(pair.session);
    if (active.turnId === turnId) setActiveTurn(pair.session, turnId, opts.finalStatus);
  }
  expireTurnPermissions(pair, turnId);
  cancelTurnToolCalls(pair, turnId);
}

/** turn 退出时该 turn 的 pending 权限请求失效迁移（expired），不残留 pending 项 */
export function expireTurnPermissions(pair: DocPair, turnId: string): void {
  for (const permission of getPendingPermissions(pair.session).values()) {
    if (permission.get("turnId") !== turnId || permission.get("status") !== "pending") continue;
    permission.set("status", "expired");
  }
}

/**
 * turn 退出时该 turn 的工具调用收敛：
 * - awaiting_permission → cancelled（权限已随 turn 失效）
 * - running → cancelled（取消/退出后 agent 不会再发工具终态事件，running 是死状态；
 *   若正常完成，工具结果通常先于 turn_completed 到达，乱序场景下保守显示 cancelled
 *   而非永久转圈）
 * 返回收敛数量（供调用方观测，与单条 CAS 语义对齐）。
 */
export function cancelTurnToolCalls(pair: DocPair, turnId: string): number {
  let count = 0;
  for (const tool of getToolCallsMap(pair.chat).values()) {
    if (tool.get("turnId") !== turnId) continue;
    const status = tool.get("status");
    if (status === "awaiting_permission" || status === "running") {
      tool.set("status", "cancelled");
      count++;
    }
  }
  return count;
}
