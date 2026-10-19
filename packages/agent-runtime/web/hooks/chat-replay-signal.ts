// packages/agent-runtime/web/hooks/chat-replay-signal.ts
// 「是否还需要等待历史回放」的唯一判定：优先级 active > localCreate > complete。
//
// - active：服务端已开启回放窗口（presenting=replaying），必须等 replay_complete；
//   即使本地 create 标记泄漏到多标签切换，也不能跳过回放。
// - localCreate：本地 create_session 没有历史，空状态应立即可见。
// - complete：服务端在 load/resume 响应后显式通知回放结束（含零历史），立即结束门控。

export type ChatReplayState = "active" | "complete" | null | undefined;

export function resolveNoReplaySession(input: {
  readonly localCreate: boolean;
  readonly replayState: ChatReplayState;
}): boolean {
  if (input.replayState === "active") return false;
  return input.localCreate || input.replayState === "complete";
}
