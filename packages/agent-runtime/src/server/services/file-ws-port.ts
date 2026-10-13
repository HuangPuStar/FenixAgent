/** Runtime 适配 `/acp/file-ws` 时所需的 Machine 文件传输能力。 */
export interface FileWsPort {
  checkParsedObjectSize(data: unknown, maxPayloadBytes: number): boolean;
  checkWsMessageSize(message: string | Uint8Array, maxPayloadBytes: number): boolean;
  estimateWsMessageBytes(data: unknown): number;
  formatFileWsCloseLog(wsId: string, code: number, reason?: string): string;
  handleFileWsClose(ws: unknown, wsId: string): void;
  handleFileWsMessage(ws: unknown, wsId: string, data: string | Record<string, unknown>): void;
  handleFileWsOpen(ws: unknown, wsId: string): void;
  parseFileWsMessage(raw: string): Record<string, unknown>[];
}

let fileWsPort: FileWsPort | null = null;

/** 由 apps/server 绑定 Machine 的文件 WebSocket 实现。 */
export function bindFileWsPort(port: FileWsPort): void {
  fileWsPort = port;
}

/** 缺失宿主装配时明确失败，避免 runtime 反向导入 Machine 包。 */
export function getFileWsPort(): FileWsPort {
  if (!fileWsPort) throw new Error("File WebSocket port has not been bound");
  return fileWsPort;
}

/** 测试后清空绑定，避免模块级状态污染。 */
export function resetFileWsPort(): void {
  fileWsPort = null;
}
