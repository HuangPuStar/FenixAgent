/** 格式化 file-ws 关闭事件，保留底层 WebSocket 的诊断信息。 */
export function formatFileWsCloseLog(wsId: string, code: number, reason?: string): string {
  return `[File-WS] Connection closed: wsId=${wsId} code=${code} reason=${reason || "(none)"}`;
}
