// packages/agent-runtime/web/__tests__/stable-sync-session-key.test.ts
// ACP 会话 id → 同步投影 sessionKey 的派生边界：首次补全、空值与同名值都不应触发重建，
// 只有真实 ACP 会话切换才改变 key；命名空间变化必须重置基线。

import { describe, expect, test } from "bun:test";
import { deriveStableSyncSessionKey, type StableSyncSessionKeyState } from "../agent-panel/use-chat-panel-runtime";

const NAMESPACE = "rcs_session_a";

/** 按顺序喂入 ACP id 序列，返回最终派生状态，模拟组件多次渲染。 */
function deriveSequence(values: (string | null | undefined)[]): StableSyncSessionKeyState {
  return values.reduce<StableSyncSessionKeyState>(
    (previous, value) => deriveStableSyncSessionKey(previous, NAMESPACE, value),
    deriveStableSyncSessionKey(null, NAMESPACE, null),
  );
}

describe("deriveStableSyncSessionKey", () => {
  // 初始空值没有会话可绑定，key 保持空，避免把未就绪状态当成切换。
  test("初始空值不产生 key", () => {
    expect(deriveStableSyncSessionKey(null, NAMESPACE, null)).toEqual({
      namespace: NAMESPACE,
      seenAcpSessionId: null,
      key: null,
    });
  });

  // 会话建立后的首个 ACP id 是补全而非切换：只记录基线，不改变 key。
  test("首个非空值只记录为基线", () => {
    const state = deriveSequence([null, "ses_first"]);

    expect(state.seenAcpSessionId).toBe("ses_first");
    expect(state.key).toBeNull();
  });

  // 切换过程中的短暂空值不得清除已见 id，否则同一会话恢复会被误判成下一次「首次补全」。
  test("空值忽略且保留已见会话", () => {
    const established = deriveSequence(["ses_first"]);
    const afterEmpty = deriveSequence(["ses_first", null, undefined]);

    expect(afterEmpty).toEqual(established);
  });

  // 相同 ACP id 重复上报必须保持对象不变，避免外层按引用触发投影重建。
  test("同名会话重复上报不改变派生状态", () => {
    const first = deriveStableSyncSessionKey(null, NAMESPACE, "ses_first");
    const switched = deriveStableSyncSessionKey(first, NAMESPACE, "ses_second");
    const repeated = deriveStableSyncSessionKey(switched, NAMESPACE, "ses_second");

    expect(repeated).toBe(switched);
  });

  // 已见会话变成另一个非空 id 才是真实切换，此时 key 更新并触发投影重建。
  test("真实 ACP 会话切换更新 key", () => {
    const state = deriveSequence(["ses_first", "ses_second"]);

    expect(state.seenAcpSessionId).toBe("ses_second");
    expect(state.key).toBe("ses_second");
  });

  // 命名空间（RCS 会话）变化时整体重置：新会话的首个值只作基线，不因与旧值不同而重建投影。
  test("命名空间变化后的首个值不算切换", () => {
    const previous = deriveStableSyncSessionKey(
      { namespace: "rcs_old", seenAcpSessionId: "ses_old", key: "ses_old" },
      "rcs_new",
      "ses_new",
    );

    expect(previous).toEqual({ namespace: "rcs_new", seenAcpSessionId: "ses_new", key: null });

    const switched = deriveStableSyncSessionKey(previous, "rcs_new", "ses_next");
    expect(switched.key).toBe("ses_next");
  });
});
