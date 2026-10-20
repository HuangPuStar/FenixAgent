// apps/web/src/__tests__/chat-replay-signal.test.ts
// 「是否还需要等回放」判定：已有空会话 / 本地新建 / 切到空会话立即放行；active 回放优先于本地标记。

import { describe, expect, test } from "bun:test";
import type { SessionStateSnapshot } from "@fenix/chat-channel";
import { resolveNoReplaySession } from "../../../../packages/agent-runtime/web/hooks/chat-replay-signal";
import { applyChatHydration } from "../../../../packages/agent-runtime/web/hooks/use-chat-hydration";

describe("chat replay signal", () => {
  // 服务端在 load/resume 后通知 replay_complete（零历史）：已有空会话立即结束门控。
  test("已有空会话的 replay_complete 立即放行", () => {
    expect(resolveNoReplaySession({ localCreate: false, replayState: null, timelineEmpty: true })).toBe(true);
  });

  // 已有空会话 + 门控：不挂伪 loading，空状态立即渲染（无骨架、无 1.5s 等待）。
  test("已有空会话不显示骨架", () => {
    const noReplay = resolveNoReplaySession({ localCreate: false, replayState: null, timelineEmpty: true });
    const legacy = {
      acpSessionId: "ses-empty",
      sessionStatus: "ready",
      status: "idle",
      loading: null,
      canCancel: false,
      structuredMessages: [],
      pendingQuestions: new Map(),
      agentPublicError: null,
      replayState: "complete",
    } satisfies SessionStateSnapshot & { replayState: "complete" };
    const gated = applyChatHydration(
      legacy,
      { messages: [], hydrating: true },
      { syncEnabled: true, legacyFallback: false, noReplaySession: noReplay },
    );
    expect(gated.loading).toBeNull();
    expect(gated.structuredMessages).toEqual([]);
  });

  // 本地 create_session 没有历史：即使还没有服务端状态，也直接显示空状态。
  test("本地新建会话立即放行", () => {
    expect(resolveNoReplaySession({ localCreate: true, replayState: null })).toBe(true);
  });

  // 切到一个已有空会话：服务端完成通知到达后立即放行。
  test("切换到已有空会话立即放行", () => {
    expect(resolveNoReplaySession({ localCreate: false, replayState: "complete" })).toBe(true);
  });

  // 首次加载已有非空会话：旧路径已有消息，不再等无活动兜底。
  test("已有消息立即放行", () => {
    expect(resolveNoReplaySession({ localCreate: false, replayState: null, hasMessages: true })).toBe(true);
  });

  // 多标签：本地 create 标记泄漏到另一标签的 active 回放时，active 必须优先，不得跳过门控。
  test("active 回放优先于本地 create 标记", () => {
    expect(
      resolveNoReplaySession({ localCreate: true, replayState: "active", timelineEmpty: true, hasMessages: true }),
    ).toBe(false);
  });
});
