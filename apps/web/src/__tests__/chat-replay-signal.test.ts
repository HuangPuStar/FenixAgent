// apps/web/src/__tests__/chat-replay-signal.test.ts
// 「是否还需要等回放」判定：已有空会话 / 本地新建 / 切到空会话立即放行；active 回放优先于本地标记。

import { describe, expect, test } from "bun:test";
import type { SessionStateSnapshot } from "@fenix/chat-channel";
import {
  bindLocalCreateToScope,
  isLocalCreateScope,
  type LocalCreateBinding,
  NO_LOCAL_CREATE,
  resolveNoReplaySession,
} from "../../../../packages/agent-runtime/web/hooks/chat-replay-signal";
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

  // 本地 create 只认领换代后的第一个 scope；同一 scope 的重复渲染不得提前绑定。
  test("create 只在换代帧绑定第一个 scope", () => {
    const unchanged = bindLocalCreateToScope({
      epoch: 1,
      scope: "s0",
      previousScope: "s0",
      binding: NO_LOCAL_CREATE,
    });
    expect(unchanged).toEqual(NO_LOCAL_CREATE);

    const bound = bindLocalCreateToScope({
      epoch: 1,
      scope: "s1",
      previousScope: "s0",
      binding: unchanged,
    });
    expect(bound).toEqual({ epoch: 1, scope: "s1" });
    expect(isLocalCreateScope(1, "s1", bound)).toBe(true);
  });

  // 远端 load 再次换代时，本地 create 标记已消费，不得再按新建会话处理。
  test("远端 load 换代不沿用已消费的 create 标记", () => {
    const binding: LocalCreateBinding = { epoch: 1, scope: "s1" };
    const afterRemoteLoad = bindLocalCreateToScope({
      epoch: 1,
      scope: "s2",
      previousScope: "s1",
      binding,
    });
    expect(afterRemoteLoad).toBe(binding);
    expect(isLocalCreateScope(1, "s2", afterRemoteLoad)).toBe(false);
  });

  // 本标签再次 create 时 epoch 递增，下一次换代重新绑定；load/resume 归零必须清除旧绑定，
  // 否则 create→load→create 后 epoch 复用 1 会命中第一次 create 的旧 scope。
  test("新 create 重新绑定，load 归零清除绑定后 epoch 复用仍可绑定", () => {
    const bound = bindLocalCreateToScope({
      epoch: 2,
      scope: "s3",
      previousScope: "s2",
      binding: { epoch: 1, scope: "s1" },
    });
    expect(bound).toEqual({ epoch: 2, scope: "s3" });
    expect(isLocalCreateScope(2, "s3", bound)).toBe(true);
    expect(bindLocalCreateToScope({ epoch: 2, scope: "s3", previousScope: "s2", binding: bound })).toBe(bound);
    expect(isLocalCreateScope(0, "s3", bound)).toBe(false);

    const afterLoad = bindLocalCreateToScope({
      epoch: 0,
      scope: "s4",
      previousScope: "s3",
      binding: bound,
    });
    expect(afterLoad).toEqual(NO_LOCAL_CREATE);

    // create→load→create 的真实序列：epoch 从 1 归零后再次为 1，必须绑定新 scope。
    const reusedEpoch = bindLocalCreateToScope({
      epoch: 1,
      scope: "s5",
      previousScope: "s4",
      binding: afterLoad,
    });
    expect(reusedEpoch).toEqual({ epoch: 1, scope: "s5" });
    expect(isLocalCreateScope(1, "s5", reusedEpoch)).toBe(true);
  });
});
