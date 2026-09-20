/**
 * 会话可删除性判定（纯函数）。
 *
 * 来源：逐字复制 `packages/agent-runtime/web/components/chat/session-actions.ts`。
 * 纯化改动点：无（无外部依赖）。
 */

/** 当前会话不能删除，避免删除后活动会话状态仍指向已删除记录。 */
export function canDeleteSession(sessionId: string, activeSessionId: string | null): boolean {
  return sessionId !== activeSessionId;
}
