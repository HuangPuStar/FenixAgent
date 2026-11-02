import { describe, expect, spyOn, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpDispatcher, createAcpSessionState } from "../acp-dispatcher";

type SentMessage = Record<string, unknown>;

interface FakeConnection {
  newSession?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  listSessions?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  loadSession?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  resumeSession?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  setSessionConfigOption?: (params: Record<string, unknown>) => Promise<void>;
  setSessionMode?: (params: Record<string, unknown>) => Promise<void>;
  deleteSession?: (params: Record<string, unknown>) => Promise<void>;
  prompt?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  cancel?: (params: Record<string, unknown>) => Promise<void>;
}

function createHarness(connection: FakeConnection | null = null, workspace = "/safe/workspace") {
  const state = createAcpSessionState();
  state.connection = connection as unknown as acp.ClientSideConnection | null;
  const sent: SentMessage[] = [];
  const dispatcher = new AcpDispatcher(state, { send: (message) => sent.push(message as SentMessage), workspace });
  return { dispatcher, sent, state };
}

function request(id: number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0" as const, id, method, params };
}

describe("AcpDispatcher round7 纯协议状态", () => {
  // 新建会话必须注入服务端 workspace，并把协商出的模型、模式和 prompt 能力返回给客户端。
  test("session/new 注入 workspace 并返回能力协商状态", async () => {
    const calls: Record<string, unknown>[] = [];
    const { dispatcher, sent, state } = createHarness({
      async newSession(params) {
        calls.push(params);
        return {
          sessionId: "ses-new",
          configOptions: [{ id: "model", currentValue: "m1", options: [{ value: "m1", name: "Model 1" }] }],
          modes: { currentModeId: "plan", availableModes: [{ id: "plan", name: "Plan" }] },
        };
      },
    });
    state.promptCapabilities = { image: true };

    await dispatcher.handleMessage(request(1, "session/new"));

    expect(calls).toEqual([{ cwd: "/safe/workspace", mcpServers: [] }]);
    expect(state.sessionId).toBe("ses-new");
    expect(sent[0]).toMatchObject({ id: 1, result: { sessionId: "ses-new", promptCapabilities: { image: true } } });
  });

  // relay 客户端自带的 mcpServers 只允许平台支持的 http 条目：放行 stdio 会让 Agent 在本机启动任意进程。
  test("session/new 只转发 http MCP 条目", async () => {
    const calls: Record<string, unknown>[] = [];
    const { dispatcher } = createHarness({
      async newSession(params) {
        calls.push(params);
        return { sessionId: "ses-new" };
      },
    });
    const httpServer = {
      type: "http",
      name: "im",
      url: "http://rcs/mcp/im",
      headers: [{ name: "Authorization", value: "Bearer token" }],
    };

    await dispatcher.handleMessage(
      request(10, "session/new", {
        mcpServers: [
          httpServer,
          { type: "stdio", name: "evil", command: "sh", args: ["-c", "id"] },
          { type: "sse", name: "legacy", url: "http://rcs/sse" },
          { name: "missing-type", url: "http://rcs/unknown" },
          null,
        ],
      }),
    );

    expect(calls).toEqual([{ cwd: "/safe/workspace", mcpServers: [httpServer] }]);
  });

  // 入站 RPC 日志不得输出请求体：IM 握手把会话 Bearer 放在 mcpServers[].headers 里。
  test("RPC 日志只记录方法与 id，不输出 token", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const { dispatcher } = createHarness({
        async newSession() {
          return { sessionId: "ses-new" };
        },
      });

      await dispatcher.handleMessage(
        request(11, "session/new", {
          mcpServers: [
            {
              type: "http",
              name: "im",
              url: "http://rcs/mcp/im",
              headers: [{ name: "Authorization", value: "Bearer secret-token" }],
            },
          ],
        }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(logs.join("\n")).not.toContain("secret-token");
    expect(logs.some((line) => line.includes("session/new"))).toBe(true);
  });

  // session/list 只能在能力协商允许后调用，防止对不支持的 agent 发出非法请求。
  test("session/list 在未协商 list 能力时拒绝", async () => {
    const { dispatcher, sent } = createHarness({});

    await dispatcher.handleMessage(request(2, "session/list"));

    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Listing sessions is not supported by this agent" } },
    ]);
  });

  // ACP 层保留 Agent 标题真相，剔除空/默认标题；用户重命名由 Fenix 持久化层提供。
  test("session/list 保留 Agent 标题并过滤不可展示会话", async () => {
    const calls: Record<string, unknown>[] = [];
    const { dispatcher, sent, state } = createHarness({
      async listSessions(params) {
        calls.push(params);
        return {
          sessions: [
            { sessionId: "ses-a", title: "New session 42" },
            { sessionId: "ses-b", title: "" },
            { sessionId: "ses-c", title: "Agent title" },
          ],
          nextCursor: "next",
        };
      },
    });
    state.agentCapabilities = { sessionCapabilities: { list: {} } };

    await dispatcher.handleMessage(request(3, "session/list", { cursor: "cursor-1", cwd: "/untrusted" }));

    expect(calls).toEqual([{ cwd: "/safe/workspace", cursor: "cursor-1" }]);
    expect(sent[0]).toMatchObject({
      id: 3,
      result: {
        sessions: [{ sessionId: "ses-c", title: "Agent title" }],
        nextCursor: "next",
      },
    });
  });

  // session/load 在能力缺失时必须拒绝，不得篡改当前 session 状态。
  test("session/load 在不支持时保留当前 session", async () => {
    const { dispatcher, sent, state } = createHarness({});
    state.sessionId = "ses-current";
    state.agentCapabilities = { loadSession: false };

    await dispatcher.handleMessage(request(4, "session/load", { sessionId: "ses-target" }));

    expect(state.sessionId).toBe("ses-current");
    expect(sent[0]).toMatchObject({ id: 4, error: { code: -32000, message: "Loading sessions is not supported" } });
  });

  // session/load 必须向连接传递受信 workspace，并只在成功后切换当前 session。
  test("session/load 成功后切换当前 session 并忽略客户端 cwd", async () => {
    const calls: Record<string, unknown>[] = [];
    const { dispatcher, sent, state } = createHarness({
      async loadSession(params) {
        calls.push(params);
        return { configOptions: [], modes: { currentModeId: "default", availableModes: [] } };
      },
    });
    state.agentCapabilities = { loadSession: true };

    await dispatcher.handleMessage(request(5, "session/load", { sessionId: "ses-target", cwd: "/attacker" }));

    expect(calls).toEqual([{ sessionId: "ses-target", cwd: "/safe/workspace", mcpServers: [] }]);
    expect(state.sessionId).toBe("ses-target");
    expect(sent[0]).toMatchObject({ id: 5, result: { sessionId: "ses-target" } });
  });

  // 恢复必须使用标准 SDK 方法，并忽略客户端提供的工作目录。
  test("session/resume 成功后绑定历史会话并可继续 prompt", async () => {
    const { dispatcher, sent, state } = createHarness({
      async resumeSession(params) {
        expect(params).toEqual({ sessionId: "ses-history", cwd: "/safe/workspace" });
        return { configOptions: [] };
      },
      async prompt(params) {
        expect(params.sessionId).toBe("ses-history");
        return { stopReason: "end_turn" };
      },
    });
    state.agentCapabilities = { sessionCapabilities: { resume: {} } };

    await dispatcher.handleMessage(request(61, "session/resume", { sessionId: "ses-history", cwd: "/untrusted" }));
    expect(sent[0]).toMatchObject({ id: 61, result: { sessionId: "ses-history" } });
    expect(state.sessionId).toBe("ses-history");
    await dispatcher.handleMessage(request(62, "session/prompt", { content: [] }));
    expect(sent.at(-1)).toMatchObject({ id: 62, result: { stopReason: "end_turn" } });
  });

  // 恢复失败必须保留已有会话状态并返回原始诊断信息。
  test("session/resume 失败不切换已有会话", async () => {
    const { dispatcher, sent, state } = createHarness({
      async resumeSession() {
        throw new Error("Session unavailable");
      },
    });
    state.sessionId = "ses-current";
    state.agentCapabilities = { sessionCapabilities: { resume: {} } };

    await dispatcher.handleMessage(request(63, "session/resume", { sessionId: "ses-missing" }));

    expect(state.sessionId).toBe("ses-current");
    expect(sent[0]).toMatchObject({
      id: 63,
      error: { code: -32603, message: "Failed to resume session: Session unavailable" },
    });
  });

  // session/resume 在未协商 resume 能力时不得触发连接调用。
  test("session/resume 在未协商能力时拒绝", async () => {
    let called = false;
    const { dispatcher, sent, state } = createHarness({
      async resumeSession() {
        called = true;
        return {};
      },
    });
    state.agentCapabilities = { sessionCapabilities: { resume: undefined } };

    await dispatcher.handleMessage(request(6, "session/resume", { sessionId: "ses-old" }));

    expect(called).toBe(false);
    expect(sent[0]).toMatchObject({ id: 6, error: { code: -32000, message: "Resuming sessions is not supported" } });
  });

  // session/setModel 只接受已协商的 modelId，并将更新精确写入当前 session。
  test("session/setModel 更新已协商模型并隔离当前 session", async () => {
    const calls: Record<string, unknown>[] = [];
    const { dispatcher, sent, state } = createHarness({
      async setSessionConfigOption(params) {
        calls.push(params);
      },
    });
    state.sessionId = "ses-model";
    state.modelState = {
      currentModelId: "m1",
      availableModels: [
        { modelId: "m1", name: "M1" },
        { modelId: "m2", name: "M2" },
      ],
    };

    await dispatcher.handleMessage(request(7, "session/setModel", { modelId: "m2" }));

    expect(calls).toEqual([{ sessionId: "ses-model", configId: "model", value: "m2" }]);
    expect(state.modelState.currentModelId).toBe("m2");
    expect(sent[0]).toMatchObject({ id: 7, result: { modelId: "m2" } });
  });

  // session/setModel 拒绝未协商模型，不能调用 agent 或污染已选模型。
  test("session/setModel 拒绝未知模型", async () => {
    let called = false;
    const { dispatcher, sent, state } = createHarness({
      async setSessionConfigOption() {
        called = true;
      },
    });
    state.sessionId = "ses-model";
    state.modelState = { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "M1" }] };

    await dispatcher.handleMessage(request(8, "session/setModel", { modelId: "forbidden" }));

    expect(called).toBe(false);
    expect(state.modelState.currentModelId).toBe("m1");
    expect(sent[0]).toMatchObject({ id: 8, error: { code: -32602, message: 'Model "forbidden" is not available' } });
  });

  // session/setMode 的 agent 错误必须标准化为 JSON-RPC 内部错误，且不乐观更新本地状态。
  test("session/setMode 失败时返回 -32603 并保留旧模式", async () => {
    const { dispatcher, sent, state } = createHarness({
      async setSessionMode() {
        throw new Error("agent unavailable");
      },
    });
    state.sessionId = "ses-mode";
    state.modeState = { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] };

    await dispatcher.handleMessage(request(9, "session/setMode", { modeId: "plan" }));

    expect(state.modeState.currentModeId).toBe("default");
    expect(sent[0]).toMatchObject({ id: 9, error: { code: -32603, message: "Failed to set mode: agent unavailable" } });
  });

  // session/delete 必须精确转发目标 session，并在成功时只确认该目标。
  test("session/delete 精确转发目标 session", async () => {
    const calls: Record<string, unknown>[] = [];
    const { dispatcher, sent } = createHarness({
      async deleteSession(params) {
        calls.push(params);
      },
    });

    await dispatcher.handleMessage(request(10, "session/delete", { sessionId: "ses-delete" }));

    expect(calls).toEqual([{ sessionId: "ses-delete" }]);
    expect(sent[0]).toMatchObject({ id: 10, result: { deleted: true, sessionId: "ses-delete" } });
  });

  // 客户端重命名不是 ACP 请求；不得用反向通知和内存缓存伪造成功。
  test("session/rename 拒绝不支持的持久变更", async () => {
    const { dispatcher, sent } = createHarness({});

    await dispatcher.handleMessage(request(11, "session/rename", { sessionId: "ses-rename", title: "隔离标题" }));

    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 11, error: { code: -32601, message: "session/rename is not supported by ACP" } },
    ]);
  });

  // 待决权限收到明确响应后必须只 resolve 对应请求并确认 RPC，其他权限继续待决。
  test("handlePermissionResponse 只完成匹配的待决权限", () => {
    const { dispatcher, sent, state } = createHarness();
    const outcomes: string[] = [];
    const timeoutA = setTimeout(() => undefined, 60_000);
    const timeoutB = setTimeout(() => undefined, 60_000);
    state.pendingPermissions.set("perm-a", {
      timeout: timeoutA,
      resolve: (outcome) => outcomes.push(`a:${outcome.outcome}`),
    });
    state.pendingPermissions.set("perm-b", {
      timeout: timeoutB,
      resolve: (outcome) => outcomes.push(`b:${outcome.outcome}`),
    });

    dispatcher.handlePermissionResponse(12, {
      requestId: "perm-a",
      outcome: { outcome: "selected", optionId: "allow" },
    });

    expect(outcomes).toEqual(["a:selected"]);
    expect(state.pendingPermissions.has("perm-a")).toBe(false);
    expect(state.pendingPermissions.has("perm-b")).toBe(true);
    expect(sent[0]).toMatchObject({ id: 12, result: { acknowledged: true } });
    clearTimeout(timeoutB);
  });

  // cancel_pending_permissions 必须取消所有权限并通知上游清理，避免 relay 断连后悬挂 Promise。
  test("cancel_pending_permissions 取消全部待决权限", async () => {
    const outcomes: string[] = [];
    const callbacks: string[] = [];
    const { dispatcher, state } = createHarness();
    const dispatcherWithCallback = new AcpDispatcher(state, {
      send: () => undefined,
      onPermissionOutcome: (requestId, outcome) => {
        callbacks.push(`${requestId}:${outcome.outcome}`);
        return true;
      },
    });
    const timeout = setTimeout(() => undefined, 60_000);
    state.pendingPermissions.set("perm-live", { timeout, resolve: (outcome) => outcomes.push(outcome.outcome) });

    await dispatcherWithCallback.handleMessage({ type: "cancel_pending_permissions" });

    expect(outcomes).toEqual(["cancelled"]);
    expect(callbacks).toEqual(["__cancel_all__:cancelled"]);
    expect(state.pendingPermissions.size).toBe(0);
    void dispatcher;
  });

  // 非法对象帧既不能被当作 RPC 分发，也不能产生伪造响应，保障同一 relay 后续会话不受污染。
  test("非法对象帧静默隔离且不发送响应", async () => {
    const { dispatcher, sent } = createHarness();

    await dispatcher.handleMessage({ jsonrpc: "1.0", id: 13, method: "session/new" });
    await dispatcher.handleMessage({ payload: "not-json-rpc" });

    expect(sent).toEqual([]);
  });
});
