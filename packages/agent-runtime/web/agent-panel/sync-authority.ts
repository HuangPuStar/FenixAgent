// packages/agent-runtime/web/agent-panel/sync-authority.ts
// 同步投影失效后的权威判定：旧通道是否可作为可信输入出口。

/**
 * 同步投影是否可作为可信输入出口。
 *
 * 仅“有错误卡”不构成恢复：旧通道缺历史时继续发送会把新问答写进不可见的投影；
 * 完整时允许继续使用旧通道，并由错误卡提供诊断。
 *
 * `syncPending` 覆盖“同步已启用但还没完成本轮基线”的窗口：用户点了历史重试后 fallback 已被清除，
 * 但新连接只是建立并不代表历史已恢复；此时旧通道仍不完整就必须继续阻断，不能提前放开输入。
 */
export function shouldBlockPromptOnIncompleteLegacy(input: {
  readonly legacyFallback: boolean;
  readonly historyIncomplete: boolean;
  readonly syncPending?: boolean;
}): boolean {
  return input.historyIncomplete && (input.legacyFallback || input.syncPending === true);
}
