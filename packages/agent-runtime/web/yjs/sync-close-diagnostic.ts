// packages/agent-runtime/web/yjs/sync-close-diagnostic.ts
// 同步协议连接关闭诊断：把 code/reason/wasClean/local 写进 console 与错误卡，
// 便于线上直接判断是服务端 1008 还是客户端主动关闭；不参与重连状态机。

export interface SyncCloseError {
  readonly code: string;
  readonly message: string;
}

/** 控制台诊断：每次连接关闭一条；reason 为服务端原始字符串。 */
export function logSyncClose(input: {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  readonly local: boolean;
}): void {
  console.warn("[sync-chat] close", {
    code: input.code,
    reason: input.reason,
    wasClean: input.wasClean,
    local: input.local,
  });
}

/** 错误卡/状态机使用的简短错误：保留原始 reason，并标注是否本地关闭/干净关闭。 */
export function formatSyncCloseError(input: {
  readonly code: string;
  readonly reason: string;
  readonly wasClean: boolean;
  readonly local: boolean;
}): SyncCloseError {
  return {
    code: input.code,
    message: `${input.reason || input.code} [wasClean=${String(input.wasClean)}, local=${String(input.local)}]`,
  };
}
