// packages/chat-channel/src/state/session-list.ts
// session_list 规范化事件 → Session Doc sessions 投影。
// 从 aggregator.ts 拆出（该文件行数接近上限）：解析 agent 侧会话列表响应
// 并全量同步到 sessions map（幂等，10s 轮询；响应中不存在的旧条目被删除，
// agent 侧删除可自愈）。

import type { NormalizedEvent, SessionSummaryProjection } from "../schema";
import type { ApplyResult } from "./aggregator";
import { syncSessionsMap } from "./chat-writer";
import type { DocPair } from "./permission";

/**
 * 处理 session_list：把 agent 侧会话列表全量同步到 Session Doc sessions 投影。
 * 缺失 sessions 数组 / 无 sessionId 的条目被拒绝（不投影）。
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
  syncSessionsMap(pair.session, summaries);
  // 列表权威确认标记：无论空/非空，session_list 响应即代表 agent 侧会话列表已确认。
  // 前端 bootstrap 据此区分「确认无会话」（可安全自动创建新会话）与「列表未到达」
  // （空列表不得触发创建，否则有历史会话时制造"假空"会话竞态）。
  pair.session.getMap("root").set("sessionListLoaded", true);
  return { applied: true };
}
