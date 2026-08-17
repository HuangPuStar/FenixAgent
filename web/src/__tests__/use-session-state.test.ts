// web/src/__tests__/use-session-state.test.ts
// computeSessionSnapshot 展示态透传测试：status/loading/canCancel 直接来自后端投影字段
// （session.presenting / session.loading / session.canCancel），前端零派生。
// 后端聚合层 turn 状态机 → 展示态的投影行为由 packages/chat-channel 包内测试覆盖，
// 前端测试只验证透传。

import { describe, expect, test } from "bun:test";
import { computeSessionSnapshot } from "../hooks/use-session-state";

/** 构造一份最小空时间线快照（computeSessionSnapshot 的 timeline 输入；
 *  历史死字段 messages/streaming/tools/artifacts 已随 SP-B2 删除） */
function emptyTimeline() {
  return { structuredMessages: [] };
}

describe("computeSessionSnapshot", () => {
  // running（正文流式输出中）→ 后端投影 presenting="responding"、loading 非空、canCancel=true：
  // 流式期间 UI 指示器不消失，同时停止按钮保持可用
  test("running 投影：presenting=responding、loading 非空、canCancel=true", () => {
    const snapshot = computeSessionSnapshot(emptyTimeline(), {
      acpSessionId: "ses-1",
      sessionStatus: "ready",
      presenting: "responding",
      loading: { kind: "session/respond", since: 123 },
      canCancel: true,
      permissionOptions: new Map(),
    });
    expect(snapshot.status).toBe("responding");
    expect(snapshot.loading).toEqual({ kind: "session/respond", since: 123 });
    expect(snapshot.canCancel).toBe(true);
    expect(snapshot.acpSessionId).toBe("ses-1");
  });

  // 历史回放 turn：后端投影 presenting="replaying"、loading=null、canCancel=false——
  // 静态历史回显，不显示伪"输出中"指示与停止按钮
  test("回放 turn 投影：presenting=replaying、loading=null、canCancel=false", () => {
    const snapshot = computeSessionSnapshot(emptyTimeline(), {
      acpSessionId: "ses-b",
      sessionStatus: "ready",
      presenting: "replaying",
      loading: null,
      canCancel: false,
      permissionOptions: new Map(),
    });
    expect(snapshot.status).toBe("replaying");
    expect(snapshot.loading).toBeNull();
    expect(snapshot.canCancel).toBe(false);
  });

  // accepting（消息刚发出，思考中）投影：loading 与 canCancel 共存——
  // 加载态照常驱动 ChatView 动画，停止按钮同时可用
  test("accepting 投影：loading 非空且 canCancel=true", () => {
    const snapshot = computeSessionSnapshot(emptyTimeline(), {
      acpSessionId: "",
      sessionStatus: "ready",
      presenting: "loading",
      loading: { kind: "session/respond", since: 456 },
      canCancel: true,
      permissionOptions: new Map(),
    });
    expect(snapshot.loading).toEqual({ kind: "session/respond", since: 456 });
    expect(snapshot.canCancel).toBe(true);
    expect(snapshot.status).toBe("loading");
  });

  // cancelling（取消已发出，等 Agent 确认）投影：loading 非空但 canCancel=false——
  // 停止按钮禁用（isCancelling 矩阵），防重复点发重取消
  test("cancelling 投影：loading 非空且 canCancel=false", () => {
    const snapshot = computeSessionSnapshot(emptyTimeline(), {
      acpSessionId: "ses-1",
      sessionStatus: "ready",
      presenting: "loading",
      loading: { kind: "session/respond", since: 789 },
      canCancel: false,
      permissionOptions: new Map(),
    });
    expect(snapshot.loading).toEqual({ kind: "session/respond", since: 789 });
    expect(snapshot.canCancel).toBe(false);
    expect(snapshot.status).toBe("loading");
  });

  // idle（无活动 turn）→ 全默认：loading=null、canCancel=false、status=idle（默认发送态）
  test("idle 投影：全默认（loading=null、canCancel=false、status=idle）", () => {
    const snapshot = computeSessionSnapshot(emptyTimeline(), {
      acpSessionId: "",
      sessionStatus: "ready",
      presenting: "idle",
      loading: null,
      canCancel: false,
      permissionOptions: new Map(),
    });
    expect(snapshot.loading).toBeNull();
    expect(snapshot.canCancel).toBe(false);
    expect(snapshot.status).toBe("idle");
  });

  // 会话就绪（sessionStatus=ready）与 turn 展示态正交：新会话/加载历史会话后无活动
  // turn（presenting=idle），sessionReady 判定必须依赖 sessionStatus——
  // 否则输入框永久禁用，第一条消息永远发不出去（死锁）
  test("无活动 turn 时 sessionStatus 仍透出 ready（会话就绪判定不依赖 turn 展示态）", () => {
    const snapshot = computeSessionSnapshot(emptyTimeline(), {
      acpSessionId: "ses-1",
      sessionStatus: "ready",
      presenting: "idle",
      loading: null,
      canCancel: false,
      permissionOptions: new Map(),
    });
    expect(snapshot.status).toBe("idle");
    expect(snapshot.sessionStatus).toBe("ready");
    expect(snapshot.loading).toBeNull();
  });
});
