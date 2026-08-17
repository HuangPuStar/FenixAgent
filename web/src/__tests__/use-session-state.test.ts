// web/src/__tests__/use-session-state.test.ts
// deriveCanCancel 纯函数测试 + computeSessionSnapshot 快照合并测试：
// turn 状态到"停止按钮是否可取消"的映射。
// 断点 1 修复：running（输出中）与 awaiting_permission（权限卡住）期间停止按钮必须可用，
// 该映射是 ChatComposer 按钮状态矩阵的前端数据源。

import { describe, expect, test } from "bun:test";
import { computeSessionSnapshot, deriveCanCancel } from "../hooks/use-session-state";

/** 构造一份最小空时间线快照（computeSessionSnapshot 的 timeline 输入） */
function emptyTimeline() {
  return { structuredMessages: [], streaming: null, tools: new Map(), artifacts: [], messages: [] };
}

describe("deriveCanCancel", () => {
  // accepting（消息刚发出）/ running（输出中）/ awaiting_permission（权限卡住）均可中断
  test("accepting/running/awaiting_permission 时 canCancel 为 true", () => {
    expect(deriveCanCancel("accepting")).toBe(true);
    expect(deriveCanCancel("running")).toBe(true);
    expect(deriveCanCancel("awaiting_permission")).toBe(true);
  });

  // cancelling（取消已发出，等 Agent 确认）与全部终态、idle 均不可再取消
  test("cancelling 与全部终态、idle 时 canCancel 为 false", () => {
    expect(deriveCanCancel("cancelling")).toBe(false);
    expect(deriveCanCancel("cancelled")).toBe(false);
    expect(deriveCanCancel("interrupted")).toBe(false);
    expect(deriveCanCancel("completed")).toBe(false);
    expect(deriveCanCancel("failed")).toBe(false);
    expect(deriveCanCancel(null)).toBe(false);
  });
});

describe("computeSessionSnapshot", () => {
  // running（正文流式输出中）时 loading 保持非空（输出中指示器持续显示）且 canCancel 为 true：
  // 流式期间 UI 指示器不消失，同时停止按钮保持可用
  test("running 时 loading 非空且 canCancel 为 true（流式输出期间有 loading 指示器）", () => {
    const snapshot = computeSessionSnapshot(emptyTimeline(), {
      acpSessionId: "ses-1",
      sessionStatus: "ready",
      turnStatus: "running",
      turnUpdatedAt: 123,
      permissionOptions: new Map(),
    });
    expect(snapshot.loading).toEqual({ kind: "session/respond", since: 123 });
    expect(snapshot.canCancel).toBe(true);
    expect(snapshot.status).toBe("responding");
    expect(snapshot.acpSessionId).toBe("ses-1");
  });

  // accepting（消息刚发出，思考中）时 loading 与 canCancel 共存：
  // 加载态照常驱动 ChatView 动画，停止按钮同时可用
  test("accepting 时 loading 非空且 canCancel 为 true", () => {
    const snapshot = computeSessionSnapshot(emptyTimeline(), {
      acpSessionId: "",
      sessionStatus: "ready",
      turnStatus: "accepting",
      turnUpdatedAt: 456,
      permissionOptions: new Map(),
    });
    expect(snapshot.loading).toEqual({ kind: "session/respond", since: 456 });
    expect(snapshot.canCancel).toBe(true);
  });

  // cancelling（取消已发出，等 Agent 确认）时 loading 非空但 canCancel 为 false：
  // 停止按钮禁用（isCancelling 矩阵），防重复点发重取消
  test("cancelling 时 loading 非空且 canCancel 为 false", () => {
    const snapshot = computeSessionSnapshot(emptyTimeline(), {
      acpSessionId: "ses-1",
      sessionStatus: "ready",
      turnStatus: "cancelling",
      turnUpdatedAt: 789,
      permissionOptions: new Map(),
    });
    expect(snapshot.loading).toEqual({ kind: "session/respond", since: 789 });
    expect(snapshot.canCancel).toBe(false);
    expect(snapshot.status).toBe("loading");
  });

  // idle（无活动 turn）时 loading 与 canCancel 均为空/false：默认发送态
  test("idle 时 loading 为 null 且 canCancel 为 false", () => {
    const snapshot = computeSessionSnapshot(emptyTimeline(), {
      acpSessionId: "",
      sessionStatus: "ready",
      turnStatus: null,
      turnUpdatedAt: null,
      permissionOptions: new Map(),
    });
    expect(snapshot.loading).toBeNull();
    expect(snapshot.canCancel).toBe(false);
    expect(snapshot.status).toBe("idle");
  });

  // 会话就绪（sessionStatus=ready）与 turn 状态正交：新会话/加载历史会话后无活动
  // turn（turnStatus=null → status=idle），sessionReady 判定必须依赖 sessionStatus——
  // 否则输入框永久禁用，第一条消息永远发不出去（死锁）
  test("无活动 turn 时 sessionStatus 仍透出 ready（会话就绪判定不依赖 turn 状态）", () => {
    const snapshot = computeSessionSnapshot(emptyTimeline(), {
      acpSessionId: "ses-1",
      sessionStatus: "ready",
      turnStatus: null,
      turnUpdatedAt: null,
      permissionOptions: new Map(),
    });
    expect(snapshot.status).toBe("idle");
    expect(snapshot.sessionStatus).toBe("ready");
    expect(snapshot.loading).toBeNull();
  });
});
