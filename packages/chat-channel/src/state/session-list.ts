// packages/chat-channel/src/state/session-list.ts
// session_list 规范化事件 → Session Doc sessions 投影。
// 从 aggregator.ts 拆出（该文件行数接近上限）：解析 agent 侧会话列表响应
// 并全量同步到 sessions map（幂等，10s 轮询；响应中不存在的旧条目被删除，
// agent 侧删除可自愈）。

import type { NormalizedEvent, SessionSummaryProjection } from "../schema";
import type { ApplyResult } from "./aggregator";
import { getSessionRoot, syncSessionsMap } from "./chat-writer";
import type { DocPair } from "./permission";

/**
 * 处理 session_list：把 agent 侧会话列表全量同步到 Session Doc sessions 投影。
 * 缺失 sessions 数组 / 无 sessionId 的条目被拒绝（不投影）。
 *
 * 空转轮询零 op 短路（SP-A2）：gateway 每 10s 轮询 list_sessions，完全相同的
 * 响应在 sessions map 无任何字段变化且 sessionListLoaded 已确认时返回
 * applied=false——配合聚合层「按触达 bump」，空闲连接的重复轮询不再产生
 * Session Doc update（消除广播帧与 Redis 快照全量 CAS）。首个响应必然写入
 * sessionListLoaded，前端 bootstrap 区分「确认无会话」与「列表未到达」的
 * 语义不受影响。
 */
export function applySessionList(pair: DocPair, event: NormalizedEvent): ApplyResult {
  const raw = event.update.sessions;
  if (!Array.isArray(raw)) return { applied: false, reason: "session_list missing sessions" };
  const summaries: SessionSummaryProjection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.sessionId !== "string" || rec.sessionId.length === 0) continue;
    summaries.push({
      sessionId: rec.sessionId,
      title: typeof rec.title === "string" ? rec.title : null,
      cwd: typeof rec.cwd === "string" ? rec.cwd : null,
      updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : null,
    });
  }
  const changed = syncSessionsMap(pair.session, summaries);
  const root = getSessionRoot(pair.session);
  if (!changed && root.get("sessionListLoaded") === true) {
    return { applied: false, reason: "session list unchanged" };
  }
  // 列表权威确认标记：无论空/非空，session_list 响应即代表 agent 侧会话列表已确认。
  // 前端 bootstrap 据此区分「确认无会话」（可安全自动创建新会话）与「列表未到达」
  // （空列表不得触发创建，否则有历史会话时制造"假空"会话竞态）。
  root.set("sessionListLoaded", true);
  return { applied: true };
}
