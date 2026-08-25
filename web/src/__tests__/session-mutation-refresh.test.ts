import { describe, expect, test } from "bun:test";
import { sendSessionMutationWithRefresh } from "../pages/agent-panel/session-mutation-refresh";

describe("会话变更后的列表刷新", () => {
  // 会话变更成功写入连接后必须立即追加列表查询，让 Yjs 会话投影尽快收敛。
  test("变更发送成功时追加 session/list", () => {
    const sent: Record<string, unknown>[] = [];
    const sendMutation = (action: Record<string, unknown>) => {
      sent.push(action);
      return true;
    };
    const sendRefresh = (action: Record<string, unknown>) => {
      sent.push(action);
      return true;
    };

    expect(
      sendSessionMutationWithRefresh(
        { action: "rename_session", sessionId: "ses-1", title: "新标题" },
        sendMutation,
        sendRefresh,
        "refresh-1",
      ),
    ).toBe(true);
    expect(sent).toEqual([
      { action: "rename_session", sessionId: "ses-1", title: "新标题" },
      { action: "list_sessions", commandId: "refresh-1" },
    ]);
  });

  // 连接不可用时不得追加无意义的列表查询，也不能掩盖原 mutation 的失败结果。
  test("变更发送失败时不追加 session/list", () => {
    const sent: Record<string, unknown>[] = [];
    const sendMutation = (action: Record<string, unknown>) => {
      sent.push(action);
      return false;
    };
    const sendRefresh = (action: Record<string, unknown>) => {
      sent.push(action);
      return true;
    };

    expect(
      sendSessionMutationWithRefresh(
        { action: "delete_session", sessionId: "ses-1" },
        sendMutation,
        sendRefresh,
        "refresh-1",
      ),
    ).toBe(false);
    expect(sent).toEqual([{ action: "delete_session", sessionId: "ses-1" }]);
  });

  // 连续会话变更的列表查询必须使用独立幂等键，避免后一次刷新被在途请求去重。
  test("连续变更为每次 session/list 使用独立 commandId", () => {
    const sent: Record<string, unknown>[] = [];
    const send = (action: Record<string, unknown>) => {
      sent.push(action);
      return true;
    };

    sendSessionMutationWithRefresh(
      { action: "rename_session", sessionId: "ses-1", title: "标题一" },
      send,
      send,
      "refresh-1",
    );
    sendSessionMutationWithRefresh(
      { action: "rename_session", sessionId: "ses-2", title: "标题二" },
      send,
      send,
      "refresh-2",
    );

    expect(sent).toEqual([
      { action: "rename_session", sessionId: "ses-1", title: "标题一" },
      { action: "list_sessions", commandId: "refresh-1" },
      { action: "rename_session", sessionId: "ses-2", title: "标题二" },
      { action: "list_sessions", commandId: "refresh-2" },
    ]);
  });
});
