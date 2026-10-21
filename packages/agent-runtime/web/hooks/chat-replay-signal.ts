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
  /** 初始连接的投影是否为空（服务端 timelineEmpty，仅 initial load 使用）。 */
  readonly timelineEmpty?: boolean;
  /** 旧路径已有可见消息：无需等待回放（回放 active 时仍以 active 优先）。 */
  readonly hasMessages?: boolean;
}): boolean {
  if (input.replayState === "active") return false;
  return (
    input.localCreate || input.replayState === "complete" || input.timelineEmpty === true || input.hasMessages === true
  );
}

/** 本地 create 请求只对紧随其后的投影换代有效；epoch 区分多次 create。 */
export interface LocalCreateBinding {
  readonly epoch: number;
  readonly scope: string | null;
}

export const NO_LOCAL_CREATE: LocalCreateBinding = { epoch: 0, scope: null };

/**
 * 把本地 create 请求认领到换代后的第一个 scope。
 * 同一 scope 的重复渲染不认领，避免把 create 之前的旧投影当成新会话；
 * 认领后 epoch 不变，后续远端 load 换代不会复用该标记。
 */
export function bindLocalCreateToScope(input: {
  readonly epoch: number;
  readonly scope: string;
  readonly previousScope: string | null;
  readonly binding: LocalCreateBinding;
}): LocalCreateBinding {
  // load/resume 归零后必须丢弃旧 create 的绑定，否则下一次 create 复用 epoch=1 会命中旧 scope。
  if (input.epoch <= 0) return input.binding.epoch === 0 ? input.binding : NO_LOCAL_CREATE;
  if (input.binding.epoch === input.epoch) return input.binding;
  if (input.previousScope === null || input.previousScope === input.scope) return input.binding;
  return { epoch: input.epoch, scope: input.scope };
}

/** 当前 scope 是否由本次本地 create 产生；load/resume 归零或换代后不再成立。 */
export function isLocalCreateScope(epoch: number, scope: string, binding: LocalCreateBinding): boolean {
  return epoch > 0 && binding.epoch === epoch && binding.scope === scope;
}
