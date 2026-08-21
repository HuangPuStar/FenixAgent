import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpDispatcher, createAcpSessionState } from "../acp-dispatcher";

type SentMessage = Record<string, unknown>;

interface FakeConnection {
  newSession?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  listSessions?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  loadSession?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  unstable_resumeSession?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
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

  // session/list 只能在能力协商允许后调用，防止对不支持的 agent 发出非法请求。
  test("session/list 在未协商 list 能力时拒绝", async () => {
    const { dispatcher, sent } = createHarness({});

    await dispatcher.handleMessage(request(2, "session/list"));

    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Listing sessions is not supported by this agent" } },
    ]);
  });

  // session/list 必须使用本地标题覆盖、剔除空/默认标题，并限制可见列表，避免错误会话污染前端。
  test("session/list 应用标题覆盖并过滤不可展示会话", async () => {
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
    state.titleOverrides.set("ses-a", "用户命名");

    await dispatcher.handleMessage(request(3, "session/list", { cursor: "cursor-1", cwd: "/untrusted" }));

    expect(calls).toEqual([{ cwd: "/safe/workspace", cursor: "cursor-1" }]);
    expect(sent[0]).toMatchObject({
      id: 3,
      result: {
        sessions: [
          { sessionId: "ses-a", title: "用户命名" },
          { sessionId: "ses-c", title: "Agent title" },
        ],
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

  // session/resume 在未协商 resume 能力时不得触发连接调用。
  test("session/resume 在未协商能力时拒绝", async () => {
    let called = false;
    const { dispatcher, sent, state } = createHarness({
      async unstable_resumeSession() {
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

  // session/rename 既缓存本地标题又广播 session/update，确保不支持重命名的 agent 仍能多 session 隔离展示。
  test("session/rename 缓存标题并发送原始更新通知", async () => {
    const { dispatcher, sent, state } = createHarness({});

    await dispatcher.handleMessage(request(11, "session/rename", { sessionId: "ses-rename", title: "隔离标题" }));

    expect(state.titleOverrides.get("ses-rename")).toBe("隔离标题");
    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "ses-rename", update: { sessionUpdate: "session_info_update", title: "隔离标题" } },
      },
      { jsonrpc: "2.0", id: 11, result: { sessionId: "ses-rename", title: "隔离标题" } },
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
