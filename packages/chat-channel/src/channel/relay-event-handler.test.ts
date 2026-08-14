// packages/chat-channel/src/channel/relay-event-handler.test.ts
// RelayEventHandler 测试（C6 迁移自 src/__tests__/yjs-frontend-lifecycle.test.ts）：
// binding 校验（stale session 过滤）、错误脱敏与 RCS 隔离、status/list_sessions 门禁、
// session/new 同步、relay_closed 断链清理（C6 断链语义二）。

import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { DocManager } from "../state/doc-manager";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import {
  createBoundDocs,
  createClient,
  createRelayEvents,
  createSharedRelay,
  createWs,
} from "./connection-test-helpers";
import type { RelayMessage, SharedRelay } from "./connection-types";

/** 构造挂在 rcs-1 上的共享 relay（handle 可覆写） */
function relayOn(rcsSessionId: string, handleOverrides: Partial<SharedRelay["handle"]> = {}): SharedRelay {
  return createSharedRelay({ rcsSessionId, handle: { state: "open", send() {}, close() {}, ...handleOverrides } });
}

describe("RelayEventHandler", () => {
  // 过期 ACP session 的 update 必须在共享 relay 消费边界丢弃，不能进入 processACP。
  test("filters stale session updates against the bound ACP session", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws, acpSessionId: "active-session" }));

    await handler.createMessageHandler(relayOn("rcs-1"))({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "stale-session", update: { sessionUpdate: "agent_message_chunk" } },
    } as unknown as RelayMessage);

    expect(processed).toEqual([]);
  });

  // Agent 原始错误不得泄露到浏览器，且仅向当前 RCS 会话发送固定的安全错误。
  test.each([
    ["error", "agent_error", "Agent request failed"],
    ["session_error", "session_error", "Agent session request failed"],
  ])("redacts %s payloads before sending them to the current RCS session", async (messageType, code, message) => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const reports: Array<[string, unknown]> = [];
    const handler = createRelayEvents(registry, broadcaster, [], {
      reportError: (context, error) => reports.push([context, error]),
    });
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws, agentStatusReceived: true }));
    const raw = { type: messageType, payload: { secret: "agent-secret" }, error: "agent-secret" };

    await handler.createMessageHandler(relayOn("rcs-1"))(raw as RelayMessage);

    expect(reports).toEqual([
      [
        messageType === "error" ? "[YJS-FE] agent error" : "[YJS-FE] session error",
        { messageType, instanceId: "instance-1" },
      ],
    ]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({ type: "error", payload: { code, message } });
  });

  // 同一用户的不同 RCS 会话中，session/update 只能以当前 RCS 的 ACP session 过滤。
  test("session/update is not filtered by another RCS session for the same user", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    registry.addClient("ws-a", createClient({ rcsSessionId: "rcs-a" }));
    registry.addClient("ws-b", createClient({ rcsSessionId: "rcs-b", acpSessionId: "ses-user-b-active" }));

    // 当前 RCS 没有 active session，即使同用户另一个 RCS 有 active session 也不应被过滤。
    await handler.createMessageHandler(relayOn("rcs-a"))({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses-user-a-new", update: { sessionUpdate: "agent_message_chunk" } },
    } as unknown as RelayMessage);

    // 私有帧经 ACPChannel 翻译为规范化事件后进入聚合层
    expect(processed).toEqual(["message_delta"]);
  });

  // 同一用户的不同 RCS 会话中，status 只能解除当前 RCS 的 session/list 门禁。
  test("status does not mark another RCS session as initialized for the same user", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const handler = createRelayEvents(registry, broadcaster, []);
    registry.addClient("ws-a", createClient({ rcsSessionId: "rcs-a" }));
    registry.addClient("ws-b", createClient({ rcsSessionId: "rcs-b" }));
    const sent: unknown[] = [];
    const relay = relayOn("rcs-a", {
      send: async (message) => void sent.push(message),
    });

    // 就绪 status（capabilities 非空）才解除当前 RCS 的 session/list 门禁
    await handler.createMessageHandler(relay)({
      type: "status",
      payload: { connected: true, capabilities: { loadSession: true } },
    } as RelayMessage);

    expect(registry.getClient("ws-a")?.agentStatusReceived).toBe(true);
    expect(registry.getClient("ws-b")?.agentStatusReceived).toBe(false);
    expect(sent).toHaveLength(1);
  });

  // agent 未就绪的 status（capabilities 为空：acp-link 在 SDK 连接后立即 resend、
  // 早于 initialize 完成）不得标记就绪、不得触发 list_sessions：否则前端 list_sessions
  // 守卫放行但 agent 丢弃请求（无响应），bootstrap 误判无会话自动创建空会话（冷启动页面为空根因）。
  // 真实 payload 中 capabilities 为 null（state.agentCapabilities 未初始化），undefined 是包裹格式缺字段。
  test.each([
    null,
    undefined,
  ])("status with capabilities=%p does not mark ready nor send list_sessions", async (capabilities) => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const handler = createRelayEvents(registry, broadcaster, []);
    registry.addClient("ws-1", createClient());
    const sent: unknown[] = [];
    const relay = relayOn("rcs-1", {
      send: async (message) => void sent.push(message),
    });

    await handler.createMessageHandler(relay)({
      type: "status",
      payload: { connected: true, capabilities },
    } as unknown as RelayMessage);

    expect(registry.getClient("ws-1")?.agentStatusReceived).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // status 自动 list_sessions 的 Promise 拒绝必须被等待、捕获并以安全上下文记录。
  test("captures rejected automatic list_sessions sends", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const reports: Array<[string, unknown]> = [];
    const handler = createRelayEvents(registry, broadcaster, [], {
      reportError: (context, error) => reports.push([context, error]),
    });
    registry.addClient("ws-1", createClient());

    await handler.createMessageHandler(
      relayOn("rcs-1", {
        send: async () => {
          throw new Error("send rejected");
        },
      }),
    )({
      type: "status",
      payload: { capabilities: { loadSession: true }, rpcPayload: "do-not-log" },
    } as unknown as RelayMessage);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.[0]).toBe("[YJS-FE] auto list_sessions send failed: instanceId=instance-1");
  });

  // Agent 断连 status（connected:false：子进程死亡/连接关闭，acp-link 只发该帧
  // 不报错不关 relay）必须把活动 turn 收敛为 interrupted：否则 turn 永久卡
  // accepting/running、前端 loading 永不消失、仅刷新可恢复（R1）。
  test("status connected:false interrupts the active turn", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);

    await handler.createMessageHandler(relayOn("rcs-1"))({
      type: "status",
      payload: { connected: false },
    } as unknown as RelayMessage);

    expect(processed).toContain("turn_interrupted");
  });

  // Agent 子进程死亡后 acp-link 以 JSON-RPC error 响应拒绝 prompt（-32000 "No
  // active session"），该帧无法归一化为终态事件；relay 必须按在途 prompt 登记
  // 收敛 turn_failed，否则 turn 永久卡 accepting、前端 loading 永不消失（R1）。
  // 错误内容脱敏（不泄露 acp-link 原始 message），登记消费后删除。
  test("prompt error response converges the turn via the pending prompt registration", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const reports: Array<[string, unknown]> = [];
    const handler = createRelayEvents(registry, broadcaster, processed, {
      reportError: (message, error) => reports.push([message, error]),
    });
    const shared = relayOn("rcs-1");
    // prompt 请求出口登记（session-channel send_prompt 分支）
    shared.pendingPromptIds = new Set([1]);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "No active session" },
    } as unknown as RelayMessage);

    expect(processed).toContain("turn_failed");
    expect(shared.pendingPromptIds?.size).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.[0]).toContain("prompt rejected");
    expect(reports[0]?.[1]).toEqual({ instanceId: "instance-1", code: -32000 });
  });

  // 未登记的 JSON-RPC error（非 send_prompt 在途请求）不得收敛 turn：
  // 错误帧只按登记匹配收敛，prompt 之外的错误不派发终态事件。
  test("unregistered error responses do not converge the turn", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);

    await handler.createMessageHandler(relayOn("rcs-1"))({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32603, message: "Failed to set model" },
    } as unknown as RelayMessage);

    expect(processed).not.toContain("turn_failed");
  });

  // prompt 静默超时（gateway 定时器到点且 agent 全程无业务帧）时，convergeStuckPrompt
  // 必须收敛 turn_failed 并消费登记、清除定时器（B 方案：防前端 loading 永久卡死）。
  test("convergeStuckPrompt converges the turn and clears pending registration", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const reports: Array<[string, unknown]> = [];
    const handler = createRelayEvents(registry, broadcaster, processed, {
      reportError: (message, error) => reports.push([message, error]),
    });
    const shared = relayOn("rcs-1");
    const timer = setTimeout(() => {}, 1000);
    shared.pendingPromptIds = new Set([1]);
    shared.pendingPromptTimeouts = new Map([[1, timer]]);

    handler.convergeStuckPrompt(shared, 1);

    expect(processed).toContain("turn_failed");
    expect(shared.pendingPromptIds?.size).toBe(0);
    expect(shared.pendingPromptTimeouts?.size).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.[0]).toContain("prompt timed out");
    clearTimeout(timer);
  });

  // 未登记的超时 id 不得收敛（与 error 路径的登记匹配语义一致），幂等保护。
  test("convergeStuckPrompt ignores unregistered prompt ids", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    const shared = relayOn("rcs-1");

    handler.convergeStuckPrompt(shared, 99);

    expect(processed).not.toContain("turn_failed");
  });

  // prompt 成功路径的 JSON-RPC result 响应（acp-link 的 session/prompt 返回 turnId）
  // 必须消费在途 prompt 登记并清除定时器，否则登记永久残留（成功路径残留修复）。
  test("prompt success result consumes the pending prompt registration", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    const shared = relayOn("rcs-1");
    const timer = setTimeout(() => {}, 1000);
    shared.pendingPromptIds = new Set([1]);
    shared.pendingPromptTimeouts = new Map([[1, timer]]);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { turnId: "turn_1" },
    } as unknown as RelayMessage);

    expect(shared.pendingPromptIds?.size).toBe(0);
    expect(shared.pendingPromptTimeouts?.size).toBe(0);
    clearTimeout(timer);
  });

  // lastInboundAt 只被业务帧刷新（JSON-RPC 帧或非保活私有帧），保活帧不得刷新——
  // 否则 relay 连接存活期间 prompt 超时判定永不触发（B 方案核心前提）。
  test("lastInboundAt is refreshed by business frames but not keepalive frames", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    const shared = relayOn("rcs-1");
    const before = Date.now();

    // 保活帧：不刷新
    await handler.createMessageHandler(shared)({ type: "keep_alive" } as unknown as RelayMessage);
    expect(shared.lastInboundAt).toBeUndefined();

    // JSON-RPC 帧：刷新
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses-1", update: { sessionUpdate: "agent_message_chunk" } },
    } as unknown as RelayMessage);
    expect(shared.lastInboundAt).toBeGreaterThanOrEqual(before);
  });

  // relay 错误只发送给当前 RCS 会话，其他用户或会话不得收到 Agent 错误。
  test("sends relay error messages only to the matching RCS session", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const handler = createRelayEvents(registry, broadcaster, []);
    const ws1 = createWs();
    const ws2 = createWs();
    registry.addClient("ws-1", createClient({ ws: ws1, rcsSessionId: "rcs-a", agentStatusReceived: true }));
    registry.addClient("ws-2", createClient({ ws: ws2, rcsSessionId: "rcs-b", agentStatusReceived: true }));

    await handler.createMessageHandler(relayOn("rcs-a"))({
      type: "error",
      payload: { message: "test-error" },
    } as unknown as RelayMessage);

    expect(ws1.messages.length).toBeGreaterThanOrEqual(1);
    expect(ws2.messages).toHaveLength(0);
    expect(JSON.parse(ws1.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "agent_error", message: "Agent request failed" },
    });
  });

  // 同一用户的不同 RCS 会话中，session/new 只能更新当前 RCS 的 ACP session ID。
  test("session/new does not overwrite another RCS session for the same user", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const registered: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, [], {
      registerYjsDocListener: (_ydoc, docName) => {
        registered.push(docName);
      },
    });
    registry.addClient("ws-a", createClient({ rcsSessionId: "rcs-a" }));
    registry.addClient("ws-b", createClient({ rcsSessionId: "rcs-b", acpSessionId: "ses-user-b" }));
    const shared = relayOn("rcs-a");
    // 会话同步分支只放行请求出口登记过的在途请求（id → 会话同步身份）
    shared.pendingSessionSyncIds = new Set([1]);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses-user-a-new", configOptions: [] },
    } as unknown as RelayMessage);

    expect(registry.getClient("ws-a")?.acpSessionId).toBe("ses-user-a-new");
    expect(registry.getClient("ws-b")?.acpSessionId).toBe("ses-user-b");
    expect(registered).toContain("session:rcs-a");
  });

  // relay 已释放（destroyed=true）后，relay-event-handler 收到 session/new result 不得补注册
  // session: 监听器：relay 已销毁，注册只会留下无注销点的僵尸条目（B-P2.3 竞态窗口）。
  test("does not register the session: listener from session/new after the relay was destroyed", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const registered: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, [], {
      registerYjsDocListener: (_ydoc, docName) => {
        registered.push(docName);
      },
    });
    const shared = { ...relayOn("rcs-1"), destroyed: true };
    // 会话同步分支只放行请求出口登记过的在途请求（id → 会话同步身份）
    shared.pendingSessionSyncIds = new Set([1]);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses_new", configOptions: [] },
    } as unknown as RelayMessage);

    expect(registered).toEqual([]);
  });

  // session/new、load 响应携带的 models/modes（acp-link 已从 configOptions 提取，
  // SDK 0.28+ 无独立 models 字段）必须随 session_updated 投影到 Session Doc session map，
  // 前端据此显示模型名与模式选择器（C 回归：此前 result 分支丢弃该元数据）。
  // title 同样必须投影：clearSessionDocContent 每次切换清空 session map，前端兜底
  // 用 session.title 显示当前会话，缺失会导致侧边栏显示"新会话"。
  test("session/new result projects models, modes and title into the session doc", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const shared = relayOn("rcs-1");
    // 会话同步分支只放行请求出口登记过的在途请求（id → 会话同步身份）
    shared.pendingSessionSyncIds = new Set([1]);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessionId: "ses-new",
        title: "My Session",
        models: {
          currentModelId: "model-b",
          availableModels: [
            { modelId: "model-a", name: "Model A" },
            { modelId: "model-b", name: "Model B" },
          ],
        },
        modes: {
          currentModeId: "code",
          availableModes: [{ id: "code", name: "Code", description: "Code mode" }],
        },
      },
    } as unknown as RelayMessage);

    const session = sessionDoc.getMap("root").get("session") as Y.Map<unknown>;
    expect(session.get("title")).toBe("My Session");
    const modelState = session.get("modelState") as Y.Map<unknown>;
    expect(modelState.get("currentModelId")).toBe("model-b");
    const models = modelState.get("availableModels") as Y.Array<Y.Map<unknown>>;
    expect(models.length).toBe(2);
    expect(models.get(1)?.get("name")).toBe("Model B");
    const modeState = session.get("modeState") as Y.Map<unknown>;
    expect(modeState.get("currentModeId")).toBe("code");
    expect((modeState.get("availableModes") as Y.Array<Y.Map<unknown>>).length).toBe(1);
  });

  // 会话同步分支必须校验在途请求登记（JSON-RPC 响应无 method 字段）：rename 响应
  // 同样携带 sessionId/title 但未经登记，不得 clobber registry 活跃会话、不得误开
  // 回放窗口、不得投影 title——否则重命名非当前会话时，活跃会话绑定被改写、
  // 绑定校验丢弃其全部 session/update 增量（输出流冻结），标题也被错误覆盖（M1）。
  test("rename result without pending session sync does not hijack the session sync branch", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-current" }));
    const shared = relayOn("rcs-1");

    // rename 非当前会话 ses-other 的响应：未登记（pendingSessionSyncIds 为空）
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses-other", title: "Renamed" },
    } as unknown as RelayMessage);

    // 活跃会话绑定不被 clobber、回放窗口不开启、title 不投影
    expect(registry.getClient("ws-1")?.acpSessionId).toBe("ses-current");
    expect(shared.replayWindowUntil).toBeNull();
    const session = sessionDoc.getMap("root").get("session") as Y.Map<unknown>;
    expect(session.get("title")).toBeUndefined();
  });

  // title 投影语义：空串视为缺省（与 acp-link list 过滤语义一致），不得用空标题
  // 覆盖已有值；字段缺失时同样保持现有值。防止 agent 返回空标题时侧边栏闪"新会话"。
  test("session sync result keeps existing title when title is empty or missing", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const shared = relayOn("rcs-1");

    // 先以登记过的 id=1 投影 "My Session"
    shared.pendingSessionSyncIds = new Set([1]);
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses-1", title: "My Session" },
    } as unknown as RelayMessage);

    // title 缺失（id=2）与空串（id=3）都不覆盖现有值
    shared.pendingSessionSyncIds = new Set([2, 3]);
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "ses-1" },
    } as unknown as RelayMessage);
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 3,
      result: { sessionId: "ses-1", title: "   " },
    } as unknown as RelayMessage);

    const session = sessionDoc.getMap("root").get("session") as Y.Map<unknown>;
    expect(session.get("title")).toBe("My Session");
  });

  // available_commands_update 通知（agent 启动后下发）经 ACPChannel 翻译为
  // session_updated 后投影到 Session Doc session map，前端 slash 命令菜单的数据源
  // （YJS 重构时被切断的链路，聚合层投影恢复）
  test("available_commands_update notification projects commands into the session doc", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-cmds" }));

    await handler.createMessageHandler(relayOn("rcs-1"))({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-cmds",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "help", description: "Show help" },
            { name: "clear", description: "Clear chat", input: { hint: "no args" } },
          ],
        },
      },
    } as unknown as RelayMessage);

    const session = sessionDoc.getMap("root").get("session") as Y.Map<unknown>;
    const availableCommands = session.get("availableCommands") as Y.Array<Y.Map<unknown>>;
    expect(availableCommands.length).toBe(2);
    expect(availableCommands.get(0)?.get("name")).toBe("help");
    expect(availableCommands.get(1)?.get("input")).toEqual({ hint: "no args" });
  });
});

// 回放窗口（replayWindowUntil）：load/resume 成功后短暂开启，窗口内无活动 turn 可写时
// 到达的 Agent 历史回放（无头增量流 / 无 turnId user_message）补全 turn 上下文投影时间线；
// 窗口外 / 实时 turn 可写时保持聚合层原语义（拒绝），避免用户消息双写。
describe("RelayEventHandler replay window", () => {
  const future = Date.now() + 60_000;
  /** reasoning_delta 等批次化事件在 16ms 合并窗口后 flush，断言前等待 flush */
  const waitFlush = () => new Promise((resolve) => setTimeout(resolve, 30));

  /** 读取指定 role 的全部 Entry 文本（text + reasoning 块拼接） */
  function entriesText(chatDoc: Y.Doc, role: "user" | "assistant"): string {
    const entries = chatDoc.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    let out = "";
    for (const entry of entries.values()) {
      if (entry.get("role") !== role) continue;
      const blocks = entry.get("blocks") as Y.Map<Y.Map<unknown>>;
      for (const block of blocks.values()) {
        const text = block.get("text") as { toString?: () => string } | undefined;
        if (text?.toString) out += text.toString();
      }
    }
    return out;
  }

  /** 统计指定 role 的 Entry 数量（验证双写防护：用户消息不得重复） */
  function countEntriesByRole(chatDoc: Y.Doc, role: "user" | "assistant"): number {
    const entries = chatDoc.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.get("role") === role) count++;
    }
    return count;
  }

  // load_session JSON-RPC 成功响应必须开启回放窗口，后续历史回放才有投影机会。
  test("load_session result opens the replay window", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const shared = relayOn("rcs-1");
    // 会话同步分支只放行请求出口登记过的在途请求（id → 会话同步身份）
    shared.pendingSessionSyncIds = new Set([1]);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses-loaded" },
    } as unknown as RelayMessage);

    expect(shared.replayWindowUntil).not.toBeNull();
    expect(shared.replayWindowUntil!).toBeGreaterThan(Date.now());
  });

  // 中断 turn 的无头回放（无 user_message 开头）：窗口内增量到达且无活动 turn 可写时，
  // 先合成回放 turn，增量才能投影为时间线（无持久化快照时历史恢复的唯一来源）。
  test("headless replay deltas inside the window are projected via a synthesized turn", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "回放思考" } },
      },
    } as unknown as RelayMessage);
    await waitFlush();

    // 合成空文本 user_message（创建 turn）+ 增量投影成功
    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
    expect(countEntriesByRole(chatDoc, "assistant")).toBe(1);
    expect(entriesText(chatDoc, "assistant")).toBe("回放思考");
  });

  // 全量回放开头（user_message 无 turnId）：窗口内分配回放 turnId，用户历史可投影。
  test("turn-less user_message inside the window is assigned a replay turnId", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "历史用户消息" } },
      },
    } as unknown as RelayMessage);

    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
    expect(entriesText(chatDoc, "user")).toBe("历史用户消息");
  });

  // 窗口外（未开启窗口）的无头增量不得合成回放 turn：保持聚合层原语义（拒绝），
  // 避免实时流 agent 回显被错误投影。
  test("deltas outside the replay window are not synthesized", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));

    await handler.createMessageHandler(relayOn("rcs-1"))({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "实时思考" } },
      },
    } as unknown as RelayMessage);

    expect(countEntriesByRole(chatDoc, "user")).toBe(0);
    expect(countEntriesByRole(chatDoc, "assistant")).toBe(0);
  });

  // 已过期的回放窗口不再合成回放 turn（窗口外语义恢复）。
  test("expired replay window does not synthesize turns", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = Date.now() - 1;

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "迟到增量" } },
      },
    } as unknown as RelayMessage);

    expect(countEntriesByRole(chatDoc, "user")).toBe(0);
  });

  // 实时流双写防护：窗口内用户已发消息（registerUserMessage 创建可写 turn），
  // agent 回显的 user_message（无 turnId）不得再次分配 turnId，用户消息不重复。
  test("turn-less user_message with a writable live turn is not assigned (live echo)", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;
    docManager.registerUserMessage("rcs-1", "实时用户消息");

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "实时用户消息" } },
      },
    } as unknown as RelayMessage);

    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
  });

  // 实时流增量防串扰：窗口内已有可写 turn（registerUserMessage 创建）时，
  // 到达的增量直接写入现有 turn，不得合成新回放 turn 造成双 turn 混乱。
  test("deltas with a writable live turn are written to the live turn, not synthesized", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;
    docManager.registerUserMessage("rcs-1", "实时用户消息");

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "实时思考" } },
      },
    } as unknown as RelayMessage);
    await waitFlush();

    // 只有一个 user entry（无合成 turn 的第二个 user entry），增量进入实时 turn
    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
    expect(entriesText(chatDoc, "assistant")).toBe("实时思考");
  });

  // 重连跳过回放语义：窗口内但 Chat Doc 已有时间线内容（prepareLoadSession 路径 1，
  // 不清空 doc 仍发 load RPC）时，不得合成新回放 turn——增量写入现有活动 turn
  // （恢复中断 turn 的补全增量），终态 turn 后的回放增量仍由聚合层拒绝（防重复）。
  test("replay is skipped when the chat doc already has timeline content", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;
    // 预写时间线内容（模拟重连场景 doc 已有历史与活动 turn）
    docManager.registerUserMessage("rcs-1", "已有历史消息");

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "回放增量" } },
      },
    } as unknown as RelayMessage);
    await waitFlush();

    // 不合成新 turn（user entry 保持 1 个），增量写入现有活动 turn
    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
    expect(entriesText(chatDoc, "assistant")).toBe("回放增量");
  });
});

// C6 断链语义二：relay_closed（Instance ACP session 断链 / 实例回收）必须删除该
// rcsSessionId 的 Chat Doc、Session Doc 热缓存与广播订阅；新连接创建全新投影，
// 绝不加载已删除的旧 Y.Doc（PRD 8.2 / issue C6 验收）。
describe("RelayEventHandler relay_closed cleanup", () => {
  // 本地实例的 relay 意外关闭：触发实例级清理（注入）、客户端收到 agent_connection_lost
  // 并关闭 1011（允许自动重连）、Chat/Session Doc 与广播订阅全部销毁。
  test("relay_closed disposes realtime resources and notifies every client of the RCS session", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc, sessionDoc } = await createBoundDocs("rcs-1");
    // 预写时间线内容，验证销毁后不残留
    chatDoc.getMap("root").set("schemaVersion", 1);
    sessionDoc.getMap("root").set("schemaVersion", 1);
    const unregistered: string[] = [];
    const origUnregister = broadcaster.unregisterYjsDocListener.bind(broadcaster);
    broadcaster.unregisterYjsDocListener = (docName) => {
      unregistered.push(docName);
      origUnregister(docName);
    };
    broadcaster.registerYjsDocListener(chatDoc, "chat:rcs-1");
    broadcaster.registerYjsDocListener(sessionDoc, "session:rcs-1");
    const stops: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, [], {
      docManager,
      terminateLocalDeadInstance: (instanceId) => stops.push(instanceId),
    });
    const ws1 = createWs();
    const ws2 = createWs();
    registry.addClient("ws-1", createClient({ ws: ws1 }));
    registry.addClient("ws-2", createClient({ ws: ws2 }));

    await handler.createMessageHandler(relayOn("rcs-1"))({
      type: "relay_closed",
      payload: { code: "relay_disconnected" },
    } as unknown as RelayMessage);

    expect(stops).toEqual(["instance-1"]);
    for (const ws of [ws1, ws2]) {
      expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
        type: "error",
        payload: { code: "agent_connection_lost", message: "Agent connection lost" },
      });
      expect(ws.closed).toEqual([[1011, "relay handle closed"]]);
    }
    expect(unregistered).toContain("chat:rcs-1");
    expect(unregistered).toContain("session:rcs-1");
    // 热缓存删除：内存中不再有 Chat / Session Doc
    expect(docManager.getChatYdoc("rcs-1")).toBeUndefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeUndefined();
  });

  // 远程实例的 relay_closed 由机器级断连清理覆盖：注入的清理钩子判定后跳过，
  // 但本节点实时资源（Doc / 广播）仍须销毁，避免僵尸热缓存被新连接复用。
  test("relay_closed still disposes local realtime resources when the host skips instance cleanup", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const stops: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, [], {
      docManager,
      // 宿主语义：远程实例不由本地死亡钩子清理（nodeId 校验排除），此处注入 no-op
      terminateLocalDeadInstance: () => {
        stops.push("skipped-remote");
      },
    });
    registry.addClient("ws-1", createClient());

    await handler.createMessageHandler(relayOn("rcs-1"))({
      type: "relay_closed",
      payload: { code: "relay_disconnected" },
    } as unknown as RelayMessage);

    expect(stops).toEqual(["skipped-remote"]);
    expect(docManager.getChatYdoc("rcs-1")).toBeUndefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeUndefined();
  });

  // 新实例创建全新实时投影：relay_closed 销毁后再次 openChat/openSession 返回全新
  // 空 Doc（含旧时间线的 snapshot 不会被加载），且旧事件对已销毁 binding 直接丢弃。
  test("reopening after relay_closed creates a fresh projection without loading the old Y.Doc", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const docManager = new DocManager();
    const chatDoc = (await docManager.openChat("rcs-1")).ydoc;
    const sessionDoc = (await docManager.openSession("user-1", "agent-1", "rcs-1")).ydoc;
    // 模拟旧实例产物已存在时间线内容（权威依据 entryOrder / entries）
    chatDoc.getMap("root").set("projectionVersion", 7);
    sessionDoc.getMap("root").set("schemaVersion", 1);
    const handler = createRelayEvents(registry, broadcaster, [], {
      docManager,
      terminateLocalDeadInstance: () => {},
    });

    // 实例断链 → 销毁热缓存
    await handler.createMessageHandler(relayOn("rcs-1"))({
      type: "relay_closed",
    } as unknown as RelayMessage);
    expect(docManager.getChatYdoc("rcs-1")).toBeUndefined();

    // 旧实例的晚到 ACP 帧：binding 已删除 → 丢弃，不重建 Doc（不产生任何投影）
    docManager.processNormalizedEvent("rcs-1", {
      type: "message_delta",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } },
      content: { type: "text", text: "late" },
    });

    // 新连接（新实例）重新打开：全新 Doc，不加载旧内容
    // （projectionVersion 为 createChatDoc 的初始值 1，而非旧实例的 7；entries 为空）
    const reopened = await docManager.openChat("rcs-1");
    expect(reopened.ydoc.getMap("root").get("projectionVersion")).toBe(1);
    expect((reopened.ydoc.getMap("root").get("entries") as Y.Map<unknown>).size).toBe(0);
  });
});
