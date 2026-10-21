import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { getEntry } from "../state/chat-writer";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import {
  createBoundDocs,
  createClient,
  createRelayEvents,
  createSharedRelay,
  createWs,
  textFrames,
} from "./connection-test-helpers";
import type { RelayMessage } from "./connection-types";
import { relayOn } from "./relay-event-test-helpers";
import { waitForSessionMutation } from "./session-mutation";

describe("RelayEventHandler", () => {
  // Agent 的 JSON-RPC 成功/失败响应必须按 id 完成对应变更等待器。
  test("settles session mutation waiters from matching RPC responses", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const handler = createRelayEvents(registry, broadcaster, []);
    const relay = relayOn("rcs-1");
    const success = waitForSessionMutation(relay, 81);
    const failure = waitForSessionMutation(relay, 82);

    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
      id: 81,
      result: { deleted: true, sessionId: "ses-target" },
    } as RelayMessage);
    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
      id: 82,
      error: { code: -32601, message: "unsupported" },
    } as RelayMessage);

    expect(await success.completed).toBe(true);
    expect(await failure.completed).toBe(false);
    expect(relay.pendingSessionMutations?.size).toBe(0);
  });
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
  ])("redacts %s payloads before sending them to the current RCS session", async (messageType, _code, _message) => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const reports: Array<[string, unknown]> = [];
    const logs: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, [], {
      reportError: (context, error) => reports.push([context, error]),
      log: (message) => logs.push(message),
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
    const frame = JSON.parse(textFrames(ws)[0] ?? "{}") as { payload: { type: string; id: string; message: string } };
    expect(frame.payload.type).toBe(
      messageType === "error" ? "AGENT_RUNTIME.REQUEST_FAILED" : "AGENT_RUNTIME.SESSION_FAILED",
    );
    expect(frame.payload.id).toMatch(/^err_[0-9a-f]{32}$/);
    expect(frame.payload.message).toBe(
      messageType === "error" ? "The Agent request failed." : "The Agent session failed.",
    );
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      event: "chat.error",
      errorId: frame.payload.id,
      errorType: frame.payload.type,
    });
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

  // 回放流可能从 AskUserQuestion 私有帧开始；此时没有活动 turn 也必须补建回放 turn，
  // 否则聚合层会拒绝 question_requested，前端无法显示待应答面板。
  test("projects an interactive question when it is the first replay event", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const relay = createSharedRelay({
      rcsSessionId: "rcs-1",
      replayWindowUntil: Date.now() + 1_000,
      replaySkipSynthesis: false,
    });

    await handler.createMessageHandler(relay)({
      type: "interactive_question",
      payload: {
        questionId: "question-1",
        toolId: "tool-1",
        toolName: "AskUserQuestion",
        questions: [
          {
            question: "Choose a deployment target",
            options: [{ label: "staging", description: "Staging environment" }],
          },
        ],
      },
    } as unknown as RelayMessage);

    const pendingQuestions = sessionDoc.getMap("root").get("pendingQuestions") as Y.Map<Y.Map<unknown>>;
    expect(pendingQuestions.get("question-1")?.get("status")).toBe("pending");
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
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws }));
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
    expect(reports[0]?.[1]).toEqual({
      instanceId: "instance-1",
      code: -32000,
      message: "No active session",
    });
    // Prompt 失败只附着到会话 turn，不发送会被 ChatPanel 渲染为顶部 banner 的 error 帧。
    expect(textFrames(ws)).toEqual([]);
  });

  // Agent 原始错误可能包含凭证、URL、本机路径和超长内容；诊断日志应保留可定位文本，
  // 但必须先脱敏、折叠空白并截断，公开错误仍维持稳定分类。
  test("prompt rejection logs a bounded redacted diagnostic message", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const reports: Array<[string, unknown]> = [];
    const handler = createRelayEvents(registry, broadcaster, [], {
      reportError: (message, error) => reports.push([message, error]),
    });
    const shared = relayOn("rcs-1");
    shared.pendingPromptIds = new Set([1]);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32603,
        message:
          "Provider failed token=live-secret at https://provider.example/error from /Users/alice/project " +
          "x".repeat(2_000),
      },
    } as unknown as RelayMessage);

    expect(reports).toHaveLength(1);
    const diagnostic = reports[0]?.[1] as Record<string, unknown>;
    expect(diagnostic.code).toBe(-32603);
    expect(diagnostic.message).toContain("Provider failed [REDACTED_SECRET]");
    expect(diagnostic.message).toContain("[REDACTED_URL]");
    expect(diagnostic.message).toContain("[REDACTED_PATH]");
    expect(diagnostic.message).not.toContain("live-secret");
    expect((diagnostic.message as string).length).toBeLessThanOrEqual(1_000);
  });

  // Peri 的结构化 prompt failure 必须按 error.data.kind/status 白名单分类；
  // message 不参与分类，未知 data 保守退化为 PROMPT_REJECTED，且原始 data 不进入前端。
  test("classifies the Peri prompt failure wire contract", async () => {
    const cases = [
      [{ kind: "internal" }, "AGENT_RUNTIME.REQUEST_FAILED"],
      [{ kind: "llm" }, "AGENT_RUNTIME.LLM_API_ERROR"],
      [{ kind: "llm_http", status: 401 }, "AGENT_RUNTIME.LLM_API_CONFIGURATION_ERROR"],
      [{ kind: "llm_http", status: 403 }, "AGENT_RUNTIME.LLM_API_CONFIGURATION_ERROR"],
      [{ kind: "llm_http", status: 429 }, "AGENT_RUNTIME.LLM_API_RATE_LIMITED"],
      [{ kind: "llm_http", status: 500 }, "AGENT_RUNTIME.LLM_API_ERROR"],
      [{ kind: "llm_http" }, "AGENT_RUNTIME.LLM_API_ERROR"],
      [{ kind: "llm_http", status: "401" }, "AGENT_RUNTIME.LLM_API_ERROR"],
      [{ kind: "unknown", status: 401 }, "AGENT_RUNTIME.PROMPT_REJECTED"],
      [{ peri: { type: "llm_api_error" } }, "AGENT_RUNTIME.PROMPT_REJECTED"],
    ] as const;

    for (const [data, expectedType] of cases) {
      const registry = new ConnectionRegistry();
      const broadcaster = new YjsBroadcaster(registry);
      const rcsSessionId = `rcs-${expectedType}-${JSON.stringify(data)}`;
      const { docManager, chatDoc } = await createBoundDocs(rcsSessionId);
      const handler = createRelayEvents(registry, broadcaster, [], { docManager });
      const shared = relayOn(rcsSessionId);
      const turnId = await docManager.registerUserMessage(rcsSessionId, "hello");
      shared.pendingPromptIds = new Set([1]);
      shared.pendingPromptTurns = new Map([[1, turnId]]);

      await handler.createMessageHandler(shared)({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32000,
          message: "An LLM API error occurred. Please check your API configuration.",
          data,
        },
      } as unknown as RelayMessage);

      expect(getEntry(chatDoc, `${turnId}:assistant`)?.get("error")).toMatchObject({
        type: expectedType,
        id: expect.stringMatching(/^err_[0-9a-f]{32}$/),
      });
    }
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

  // prompt 成功路径的 JSON-RPC result 响应（acp-link 的 session/prompt 返回 turnId）
  // 必须消费在途 prompt 登记，避免成功路径永久残留。
  test("prompt success result consumes the pending prompt registration", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    const shared = relayOn("rcs-1");
    shared.pendingPromptIds = new Set([1]);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { turnId: "turn_1" },
    } as unknown as RelayMessage);

    expect(shared.pendingPromptIds?.size).toBe(0);
  });
});
