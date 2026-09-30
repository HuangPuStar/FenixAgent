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
  manager.on("session_error", (relayId: string, payload: unknown) => {
    events.push({ relayId, event: "session_error", payload });
  });
  Reflect.set(manager, "sharedConnection", connection);

  return { manager, events, notifications };
}

describe("SessionManager 旧 relay 重命名", () => {
  // 旧 relay 入口也不得用反向通知伪造持久重命名成功。
  test("rename_session 返回不支持且保持 Agent 列表原貌", async () => {
    const { manager, events, notifications } = createManagerForRename();

    await manager.sendData("relay-a", {
      type: "rename_session",
      payload: { sessionId: "ses-renamed", title: "用户更新的标题" },
    });

    expect(notifications).toEqual([]);
    expect(events).toEqual([
      {
        relayId: "relay-a",
        event: "session_error",
        payload: "session/rename is not supported by ACP",
      },
    ]);
    expect(events.some((event) => event.relayId !== "relay-a")).toBe(false);
  });
});
