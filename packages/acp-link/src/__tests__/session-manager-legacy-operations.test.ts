import { describe, expect, test } from "bun:test";
import { SessionManager } from "../client/session-manager";

interface SessionEvent {
  relayId: string;
  event: string;
  payload: unknown;
}

interface SessionInfo {
  sessionId: string;
  title: string;
}

interface RenameConnection {
  listSessions(): Promise<{ sessions: SessionInfo[] }>;
  connection: {
    sendNotification(method: string, params: Record<string, unknown>): void;
  };
}

function createManagerForRename(): {
  manager: SessionManager;
  events: SessionEvent[];
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const manager = new SessionManager("unused-agent");
  const events: SessionEvent[] = [];
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const connection: RenameConnection = {
    async listSessions() {
      return {
        sessions: [
          { sessionId: "ses-renamed", title: "Agent 返回的旧标题" },
          { sessionId: "ses-other", title: "其他会话" },
        ],
      };
    },
    connection: {
      sendNotification(method, params) {
        notifications.push({ method, params });
      },
    },
  };

  manager.on("session_data", (relayId: string, payload: unknown) => {
    events.push({ relayId, event: "session_data", payload });
  });
  Reflect.set(manager, "sharedConnection", connection);

  return { manager, events, notifications };
}

describe("SessionManager 旧 relay 重命名", () => {
  // 重命名必须只通知当前 relay，并以本地标题覆盖随后列表中的 Agent 旧值，防止不同 relay 的历史记录串台。
  test("rename_session 转发更新并向发起 relay 返回覆盖后的列表", async () => {
    const { manager, events, notifications } = createManagerForRename();

    await manager.sendData("relay-a", {
      type: "rename_session",
      payload: { sessionId: "ses-renamed", title: "用户更新的标题" },
    });

    expect(notifications).toEqual([
      {
        method: "session/update",
        params: {
          sessionId: "ses-renamed",
          update: { sessionUpdate: "session_info_update", title: "用户更新的标题" },
        },
      },
    ]);
    expect(events).toEqual([
      {
        relayId: "relay-a",
        event: "session_data",
        payload: {
          type: "session_renamed",
          payload: { sessionId: "ses-renamed", title: "用户更新的标题" },
        },
      },
      {
        relayId: "relay-a",
        event: "session_data",
        payload: {
          type: "session_list",
          payload: {
            sessions: [
              { sessionId: "ses-renamed", title: "用户更新的标题" },
              { sessionId: "ses-other", title: "其他会话" },
            ],
          },
        },
      },
    ]);
    expect(events.some((event) => event.relayId !== "relay-a")).toBe(false);
  });
});
