/** Yjs WS 连接状态，与 ChatPanel 内部 connectionState 保持一致。 */
export type ChatWsConnectionState = "disconnected" | "connecting" | "connected" | "error";

/**
 * 判断缓存 ChatPanel 从后台切回前台时是否应自动触发一次 WS 重连。
 *
 * 后台期间实例可能被 idle/activity 回收（4001）或客户端 keepalive 超时（4501）
 * 断开，这两类终态关闭码不会触发 YJS 客户端自动重连；切回前台时后端已通过
 * enter/ensureRunning 恢复实例，前端需要重建 WS 才能恢复连接。
 *
 * 约束：
 * - 只处理 pageVisible false → true 边沿（首次挂载、每次 render 均不触发）
 * - connected / connecting 状态不重复重连
 * - machine_unavailable（4500）/ environment_unavailable（4004）保留手动重试，避免无意义循环
 * - 普通网络异常仍由 YJS 客户端已有的自动重连处理
 */
export function shouldAutoReconnectOnVisible(
  previousPageVisible: boolean,
  pageVisible: boolean,
  connectionState: ChatWsConnectionState,
  errorCode: string | null,
): boolean {
  if (previousPageVisible || !pageVisible) return false;
  if (connectionState !== "disconnected" && connectionState !== "error") return false;
  // 确定性永久失败：自动重连（含页面从隐藏切回可见触发的一次连接）无意义，仅保留手动重试按钮。
  // max_sessions_reached 不在此列：实例被释放后切回前台可自动恢复，重试有成功机会。
  // environment_unavailable（4004）与 machine_unavailable 同理：重试相同 URL 永远失败。
  if (
    errorCode === "machine_unavailable" ||
    errorCode === "auto_start_disabled" ||
    errorCode === "launch_spec_build_failed" ||
    errorCode === "environment_unavailable"
  ) {
    return false;
  }
  return true;
}
