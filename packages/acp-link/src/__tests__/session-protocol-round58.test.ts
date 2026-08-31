import { describe, expect, spyOn, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { SessionManager } from "../client/session-manager";

interface SessionEvent {
  relayId: string;
  event: string;
  payload: unknown;
}

interface Call {
  method: string;
  params: Record<string, unknown>;
}

class MemoryConnection {
  calls: Call[] = [];
  notifications: Call[] = [];
  nextSession = { sessionId: "ses-created", configOptions: [] as Array<Record<string, unknown>> };
  sessions = [{ sessionId: "ses-listed", title: "已保存会话" }];
  failure: Error | null = null;

  private failIfNeeded(): void {
    if (this.failure) throw this.failure;
  }

  async newSession(params: Record<string, unknown>): Promise<typeof this.nextSession> {
    this.calls.push({ method: "newSession", params });
    this.failIfNeeded();
    return this.nextSession;
  }

  async prompt(params: Record<string, unknown>): Promise<{ stopReason: string }> {
    this.calls.push({ method: "prompt", params });
    this.failIfNeeded();
    return { stopReason: "end_turn" };
  }

  async cancel(params: Record<string, unknown>): Promise<void> {
    this.calls.push({ method: "cancel", params });
    this.failIfNeeded();
  }

  async setSessionConfigOption(params: Record<string, unknown>): Promise<void> {
    this.calls.push({ method: "setSessionConfigOption", params });
    this.failIfNeeded();
  }

  async setSessionMode(params: Record<string, unknown>): Promise<void> {
    this.calls.push({ method: "setSessionMode", params });
    this.failIfNeeded();
  }

  async unstable_resumeSession(params: Record<string, unknown>): Promise<{ sessionId?: string; configOptions: [] }> {
    this.calls.push({ method: "unstable_resumeSession", params });
    this.failIfNeeded();
    return { sessionId: "ses-resumed", configOptions: [] };
  }

  async loadSession(params: Record<string, unknown>): Promise<{ configOptions: [] }> {
    this.calls.push({ method: "loadSession", params });
    this.failIfNeeded();
    return { configOptions: [] };
  }

  async deleteSession(params: Record<string, unknown>): Promise<void> {
    this.calls.push({ method: "deleteSession", params });
    this.failIfNeeded();
  }

  async listSessions(_params: Record<string, unknown>): Promise<{ sessions: typeof this.sessions }> {
    this.failIfNeeded();
    return { sessions: this.sessions };
  }

  connection = {
    sendNotification: (method: string, params: Record<string, unknown>) => {
      this.notifications.push({ method, params });
    },
  };
}

function createHarness(): { manager: SessionManager; connection: MemoryConnection; events: SessionEvent[] } {
  const manager = new SessionManager("unused-agent", 5, "/memory/workspace");
  const connection = new MemoryConnection();
  const events: SessionEvent[] = [];
  manager.on("session_data", (relayId: string, payload: unknown) => {
    events.push({ relayId, event: "session_data", payload });
  });
  manager.on("session_error", (relayId: string, payload: unknown) => {
    events.push({ relayId, event: "session_error", payload });
  });
  Reflect.set(manager, "sharedConnection", connection);
  return { manager, connection, events };
}

function rpc(id: number, method: string, params?: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params };
}

function setActiveSession(manager: SessionManager, sessionId = "ses-active"): void {
  Reflect.set(manager, "currentAcpSessionId", sessionId);
}

describe("SessionManager round58 内存协议分支", () => {
  // 传输保活包不应触发 agent 调用或向任意 relay 泄漏事件。
  test("忽略 transport ping", async () => {
    const { manager, connection, events } = createHarness();

    await manager.sendData("relay-ping", { type: "ping" });

    expect(connection.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  // JSON-RPC 新会话必须把调用方指定工作目录原样交给内存 agent。
  test("session/new 转发显式 cwd", async () => {
    const { manager, connection, events } = createHarness();

    await manager.sendData("relay-new", rpc(1, "session/new", { cwd: "/project/a" }));

    expect(connection.calls).toEqual([{ method: "newSession", params: { cwd: "/project/a", mcpServers: [] } }]);
    expect(events[0]).toEqual({
      relayId: "relay-new",
      event: "session_data",
      payload: { jsonrpc: "2.0", id: 1, result: { ...connection.nextSession, models: null, modes: null } },
    });
  });

  // 未传 cwd 时必须使用 manager 的隔离默认目录，而不是依赖宿主机状态。
  test("session/new 使用内存默认 cwd", async () => {
    const { manager, connection } = createHarness();

    await manager.sendData("relay-default", rpc(2, "session/new"));

    expect(connection.calls[0]).toEqual({ method: "newSession", params: { cwd: "/memory/workspace", mcpServers: [] } });
  });

  // prompt 在无活动会话时应先建会话，再向同一 relay 发起 prompt。
  test("session/prompt 懒创建会话后转发内容", async () => {
    const { manager, connection, events } = createHarness();

    await manager.sendData("relay-prompt", rpc(3, "session/prompt", { content: [{ type: "text", text: "你好" }] }));
    await Promise.resolve();

    expect(connection.calls).toEqual([
      { method: "newSession", params: { cwd: "/memory/workspace", mcpServers: [] } },
      { method: "prompt", params: { sessionId: "ses-created", prompt: [{ type: "text", text: "你好" }] } },
    ]);
    expect(events.at(-1)).toEqual({
      relayId: "relay-prompt",
      event: "session_data",
      payload: { type: "prompt_complete", payload: { stopReason: "end_turn" } },
    });
  });

  // system prompt 只能注入当前一次 prompt，避免跨回合重复污染用户输入。
  test("session/prompt 单次注入 system prompt", async () => {
    const { manager, connection } = createHarness();
    setActiveSession(manager);
    manager.setSystemPrompt("系统约束");

    await manager.sendData("relay-system", rpc(4, "session/prompt", { content: [{ type: "text", text: "问题" }] }));
    await manager.sendData("relay-system", rpc(5, "session/prompt", { content: [{ type: "text", text: "后续" }] }));

    expect(connection.calls).toEqual([
      {
        method: "prompt",
        params: {
          sessionId: "ses-active",
          prompt: [
            { type: "text", text: "系统约束" },
            { type: "text", text: "问题" },
          ],
        },
      },
      { method: "prompt", params: { sessionId: "ses-active", prompt: [{ type: "text", text: "后续" }] } },
    ]);
  });

  // 异步 prompt 失败必须以请求 id 返回 JSON-RPC 错误，不能变成未处理 rejection。
  test("session/prompt 失败返回内部错误", async () => {
    const { manager, connection, events } = createHarness();
    setActiveSession(manager);
    connection.failure = new Error("prompt failed");

    await manager.sendData("relay-failure", rpc(6, "session/prompt", { content: [] }));
    await Promise.resolve();

    expect(events).toEqual([
      {
        relayId: "relay-failure",
        event: "session_data",
        payload: { jsonrpc: "2.0", id: 6, error: { code: -32603, message: "Error: prompt failed" } },
      },
    ]);
  });

  // SDK 会将 stdio JSON-RPC error 解码为 RequestError；acp-link 必须原样保留 Peri 的
  // implementation-defined code/message/data，只替换外层响应 id 以关联 relay 请求。
  test("session/prompt 透传 Peri RequestError 信封", async () => {
    const { manager, connection, events } = createHarness();
    setActiveSession(manager);
    connection.failure = new RequestError(-32000, "An LLM API error occurred. Please check your API configuration.", {
      peri: {
        type: "llm_api_error",
        retryable: false,
        provider: "example",
      },
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await manager.sendData("relay-peri-error", rpc(7, "session/prompt", { content: [] }));
      await Promise.resolve();

      expect(events).toEqual([
        {
          relayId: "relay-peri-error",
          event: "session_data",
          payload: {
            jsonrpc: "2.0",
            id: 7,
            error: {
              code: -32000,
              message: "An LLM API error occurred. Please check your API configuration.",
              data: {
                peri: {
                  type: "llm_api_error",
                  retryable: false,
                  provider: "example",
                },
              },
            },
          },
        },
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // JSON-RPC prompt 失败必须在 ACP 边界记录脱敏诊断，同时保留发往 relay 的错误协议。
  test("session/prompt 失败记录安全 ACP 日志", async () => {
    const { manager, connection, events } = createHarness();
    setActiveSession(manager);
    connection.failure = new Error(
      "Provider token=live-secret failed at https://provider.example/error from /Users/alice/project",
    );
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await manager.sendData("relay-failure", rpc(6, "session/prompt", { content: [] }));
      await Promise.resolve();

      expect(errorSpy).toHaveBeenCalledWith(
        "[session-manager] prompt failed:",
        "Error: Provider [REDACTED_SECRET] failed at [REDACTED_URL] from [REDACTED_PATH]",
      );
      expect(events[0]?.payload).toEqual({
        jsonrpc: "2.0",
        id: 6,
        error: {
          code: -32603,
          message:
            "Error: Provider token=live-secret failed at https://provider.example/error from /Users/alice/project",
        },
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  // 没有活动会话的取消仍应确认，方便客户端无条件收敛取消状态。
  test("session/cancel 无活动会话仍成功", async () => {
    const { manager, connection, events } = createHarness();

    await manager.sendData("relay-cancel", rpc(7, "session/cancel"));

    expect(connection.calls).toEqual([]);
    expect(events[0]?.payload).toEqual({ jsonrpc: "2.0", id: 7, result: { cancelled: true } });
  });

  // 有活动会话的取消必须仅携带当前 ACP 会话标识。
  test("session/cancel 转发活动会话", async () => {
    const { manager, connection } = createHarness();
    setActiveSession(manager, "ses-cancel");

    await manager.sendData("relay-cancel", rpc(8, "session/cancel"));

    expect(connection.calls).toEqual([{ method: "cancel", params: { sessionId: "ses-cancel" } }]);
  });

  // 模型设置在尚未创建会话时必须明确拒绝，不能调用 agent。
  test("session/setModel 拒绝无活动会话", async () => {
    const { manager, connection, events } = createHarness();

    await manager.sendData("relay-model", rpc(9, "session/setModel", { modelId: "fast" }));

    expect(connection.calls).toEqual([]);
    expect(events[0]?.payload).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32000, message: "No active session" },
    });
  });

  // 模型设置成功时应保留 modelId，并固定转发 model 配置键。
  test("session/setModel 更新活动会话", async () => {
    const { manager, connection, events } = createHarness();
    setActiveSession(manager, "ses-model");

    await manager.sendData("relay-model", rpc(10, "session/setModel", { modelId: "accurate" }));

    expect(connection.calls).toEqual([
      { method: "setSessionConfigOption", params: { sessionId: "ses-model", configId: "model", value: "accurate" } },
    ]);
    expect(events[0]?.relayId).toBe("relay-model");
    expect(events[0]?.payload).toEqual({ jsonrpc: "2.0", id: 10, result: { modelId: "accurate" } });
  });

  // 模式设置无活动会话时必须与模型设置同样隔离失败。
  test("session/setMode 拒绝无活动会话", async () => {
    const { manager, connection, events } = createHarness();

    await manager.sendData("relay-mode", rpc(11, "session/setMode", { modeId: "plan" }));

    expect(connection.calls).toEqual([]);
    expect(events[0]?.payload).toEqual({
      jsonrpc: "2.0",
      id: 11,
      error: { code: -32000, message: "No active session" },
    });
  });

  // 模式设置成功时只向请求 relay 回应，避免模式状态串台。
  test("session/setMode 更新活动会话", async () => {
    const { manager, connection, events } = createHarness();
    setActiveSession(manager, "ses-mode");

    await manager.sendData("relay-mode", rpc(12, "session/setMode", { modeId: "plan" }));

    expect(connection.calls).toEqual([{ method: "setSessionMode", params: { sessionId: "ses-mode", modeId: "plan" } }]);
    expect(events).toEqual([
      { relayId: "relay-mode", event: "session_data", payload: { jsonrpc: "2.0", id: 12, result: { modeId: "plan" } } },
    ]);
  });

  // resume 返回的新标识时，后续取消必须使用 agent 确认的新会话。
  test("session/resume 采用 agent 返回的会话标识", async () => {
    const { manager, connection } = createHarness();

    await manager.sendData("relay-resume", rpc(13, "session/resume", { sessionId: "ses-old" }));
    await manager.sendData("relay-resume", rpc(14, "session/cancel"));

    expect(connection.calls).toEqual([
      { method: "unstable_resumeSession", params: { sessionId: "ses-old", cwd: "/memory/workspace" } },
      { method: "cancel", params: { sessionId: "ses-resumed" } },
    ]);
  });

  // resume 的 agent 错误必须封装为对应请求的 JSON-RPC 内部错误。
  test("session/resume 失败隔离为响应错误", async () => {
    const { manager, connection, events } = createHarness();
    connection.failure = new Error("resume failed");

    await manager.sendData("relay-resume-error", rpc(15, "session/resume", { sessionId: "ses-missing" }));

    expect(events[0]).toEqual({
      relayId: "relay-resume-error",
      event: "session_data",
      payload: { jsonrpc: "2.0", id: 15, error: { code: -32603, message: "Error: resume failed" } },
    });
  });

  // load 成功后，后续操作应绑定请求指定的历史会话。
  test("session/load 绑定目标会话", async () => {
    const { manager, connection } = createHarness();

    await manager.sendData("relay-load", rpc(16, "session/load", { sessionId: "ses-history" }));
    await manager.sendData("relay-load", rpc(17, "session/cancel"));

    expect(connection.calls).toEqual([
      { method: "loadSession", params: { sessionId: "ses-history", cwd: "/memory/workspace", mcpServers: [] } },
      { method: "cancel", params: { sessionId: "ses-history" } },
    ]);
  });

  // load 失败不应写入活动会话，后续取消保持本地成功而不触达 agent。
  test("session/load 失败不污染活动会话", async () => {
    const { manager, connection, events } = createHarness();
    connection.failure = new Error("load failed");

    await manager.sendData("relay-load-error", rpc(18, "session/load", { sessionId: "ses-bad" }));
    connection.failure = null;
    await manager.sendData("relay-load-error", rpc(19, "session/cancel"));

    expect(events[0]?.payload).toEqual({
      jsonrpc: "2.0",
      id: 18,
      error: { code: -32603, message: "Error: load failed" },
    });
    expect(connection.calls).toEqual([
      { method: "loadSession", params: { sessionId: "ses-bad", cwd: "/memory/workspace", mcpServers: [] } },
    ]);
  });

  // delete 必须精确确认已删除的目标标识。
  test("session/delete 确认目标会话", async () => {
    const { manager, connection, events } = createHarness();

    await manager.sendData("relay-delete", rpc(20, "session/delete", { sessionId: "ses-delete" }));

    expect(connection.calls).toEqual([{ method: "deleteSession", params: { sessionId: "ses-delete" } }]);
    expect(events[0]?.payload).toEqual({ jsonrpc: "2.0", id: 20, result: { deleted: true, sessionId: "ses-delete" } });
  });

  // delete 的 agent 异常必须留在发起 relay 的响应范围内。
  test("session/delete 失败返回内部错误", async () => {
    const { manager, connection, events } = createHarness();
    connection.failure = new Error("delete failed");

    await manager.sendData("relay-delete-error", rpc(21, "session/delete", { sessionId: "ses-delete" }));

    expect(events).toEqual([
      {
        relayId: "relay-delete-error",
        event: "session_data",
        payload: { jsonrpc: "2.0", id: 21, error: { code: -32603, message: "Error: delete failed" } },
      },
    ]);
  });

  // rename 同时写入本地覆盖并通知 agent，随后列表必须可见新标题。
  test("session/rename 通知 agent 并覆盖列表标题", async () => {
    const { manager, connection, events } = createHarness();
    connection.sessions = [{ sessionId: "ses-rename", title: "旧标题" }];

    await manager.sendData("relay-rename", rpc(22, "session/rename", { sessionId: "ses-rename", title: "新标题" }));
    await manager.sendData("relay-rename", rpc(23, "session/list"));

    expect(connection.notifications).toEqual([
      {
        method: "session/update",
        params: { sessionId: "ses-rename", update: { sessionUpdate: "session_info_update", title: "新标题" } },
      },
    ]);
    expect(events.at(-1)?.payload).toEqual({
      jsonrpc: "2.0",
      id: 23,
      result: { sessions: [{ sessionId: "ses-rename", title: "新标题" }] },
    });
  });

  // 缺失 connection 通知接口时 rename 应作为协议错误返回，不能向其他 relay 广播。
  test("session/rename 通知失败返回内部错误", async () => {
    const { manager, events } = createHarness();
    Reflect.set(manager, "sharedConnection", {});

    await manager.sendData("relay-rename-error", rpc(24, "session/rename", { sessionId: "ses-x", title: "标题" }));

    expect(events).toEqual([
      {
        relayId: "relay-rename-error",
        event: "session_data",
        payload: { jsonrpc: "2.0", id: 24, error: { code: -32603, message: expect.any(String) } },
      },
    ]);
  });

  // JSON-RPC list 应过滤空标题和新会话占位项，防止无意义历史项暴露给前端。
  test("session/list 过滤占位和空标题", async () => {
    const { manager, connection, events } = createHarness();
    connection.sessions = [
      { sessionId: "ses-visible", title: "可见" },
      { sessionId: "ses-placeholder", title: " New Session 2 " },
      { sessionId: "ses-empty", title: "  " },
    ];

    await manager.sendData("relay-list", rpc(25, "session/list"));

    expect(events[0]).toEqual({
      relayId: "relay-list",
      event: "session_data",
      payload: { jsonrpc: "2.0", id: 25, result: { sessions: [{ sessionId: "ses-visible", title: "可见" }] } },
    });
  });

  // 未知 JSON-RPC 方法必须返回标准 Method not found，不得触发 fake agent。
  test("未知 JSON-RPC 方法拒绝且无副作用", async () => {
    const { manager, connection, events } = createHarness();

    await manager.sendData("relay-unknown", rpc(26, "session/future"));

    expect(connection.calls).toEqual([]);
    expect(events[0]?.payload).toEqual({
      jsonrpc: "2.0",
      id: 26,
      error: { code: -32601, message: "Method not found: session/future" },
    });
  });

  // stopAll 必须清除内存连接与活动标识，并请求 fake 进程优雅终止。
  test("stopAll 清理共享资源", () => {
    const manager = new SessionManager("unused-agent");
    const killedSignals: string[] = [];
    const processLike = { killed: false, kill: (signal: string) => killedSignals.push(signal) };
    Reflect.set(manager, "sharedProc", processLike);
    Reflect.set(manager, "sharedConnection", new MemoryConnection());
    setActiveSession(manager);
    Reflect.set(manager, "activeRelayId", "relay-cleanup");

    manager.stopAll();

    expect(killedSignals).toEqual(["SIGTERM"]);
    expect(manager.getAliveSessionIds()).toEqual([]);
    expect(manager.hasSession("any")).toBe(false);
    expect(Reflect.get(manager, "activeRelayId")).toBeNull();
  });

  // 仅存活且未 killed 的内存进程才可作为共享会话对外报告。
  test("共享进程存活状态准确反映", () => {
    const manager = new SessionManager("unused-agent");
    Reflect.set(manager, "sharedProc", { killed: false });

    expect(manager.getAliveSessionIds()).toEqual(["shared"]);
    expect(manager.hasSession("ignored")).toBe(true);

    Reflect.set(manager, "sharedProc", { killed: true });
    expect(manager.getAliveSessionIds()).toEqual([]);
    expect(manager.hasSession("ignored")).toBe(false);
  });
});
