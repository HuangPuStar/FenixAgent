// packages/agent-runtime/web/agent-panel/sync-authority.ts
// 同步投影失效后的权威判定：旧通道是否可作为可信输入出口。

/**
 * 同步已回退且旧通道历史不完整时阻止发送。
 *
 * 仅“有错误卡”不构成恢复：旧通道缺历史时继续发送会把新问答写进不可见的投影；
 * 完整时允许继续使用旧通道，并由错误卡提供诊断。
 */
export function shouldBlockPromptOnIncompleteLegacy(input: {
  readonly legacyFallback: boolean;
  readonly historyIncomplete: boolean;
}): boolean {
  return input.legacyFallback && input.historyIncomplete;
}
