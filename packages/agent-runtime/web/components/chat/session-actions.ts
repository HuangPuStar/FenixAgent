/** 当前会话不能删除，避免删除后活动会话状态仍指向已删除记录。 */
export function canDeleteSession(sessionId: string, activeSessionId: string | null): boolean {
  return sessionId !== activeSessionId;
}
