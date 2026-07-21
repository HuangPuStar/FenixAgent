import type { ThreadEntry, ToolCallStatus } from "./types";

/**
 * 一轮 prompt 结束时的兜底：把仍为 running 的 tool_call 标记为 complete。
 *
 * 远程 agent（如 claude --acp）有时不在工具执行完成时推送
 * status="completed" 的 session/update，导致 tool_call 永久卡在 running，
 * UI 一直转圈。这里在 prompt_complete 时统一兜底，让 UI 终止 loading。
 */
export function finalizeRunningToolCalls(entries: ThreadEntry[]): ThreadEntry[] {
  let changed = false;

  const mapEntry = (entry: ThreadEntry): ThreadEntry => {
    if (entry.type !== "tool_call") return entry;

    let nextToolCall = entry.toolCall;
    if (entry.toolCall.status === "running") {
      changed = true;
      nextToolCall = { ...entry.toolCall, status: "complete" as ToolCallStatus };
    }

    if (entry.toolCall.subEntries && entry.toolCall.subEntries.length > 0) {
      const nextSubEntries = entry.toolCall.subEntries.map(mapEntry);
      if (nextSubEntries !== entry.toolCall.subEntries || nextToolCall !== entry.toolCall) {
        return { type: "tool_call", toolCall: { ...nextToolCall, subEntries: nextSubEntries } };
      }
      return entry;
    }

    return nextToolCall === entry.toolCall ? entry : { type: "tool_call", toolCall: nextToolCall };
  };

  const next = entries.map(mapEntry);
  return changed ? next : entries;
}
