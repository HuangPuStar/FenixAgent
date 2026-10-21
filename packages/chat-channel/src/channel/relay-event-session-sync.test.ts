import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createBoundDocs, createClient, createRelayEvents, createWs, textFrames } from "./connection-test-helpers";
import type { RelayMessage } from "./connection-types";
import { relayOn } from "./relay-event-test-helpers";

describe("RelayEventHandler", () => {
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
    const frame = JSON.parse(textFrames(ws1)[0] ?? "{}") as { payload: { type: string; id: string; message: string } };
    expect(frame.payload.type).toBe("AGENT_RUNTIME.REQUEST_FAILED");
    expect(frame.payload.id).toMatch(/^err_[0-9a-f]{32}$/);
    expect(frame.payload.message).toBe("The Agent request failed.");
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

  // 迟到的会话同步响应（已被更晚的 load/create/resume 取代，如用户在响应到达前再次
  // 切换会话）不得提交：否则活跃会话回绑到旧 ACP session、投影 sessionId 被改写，
  // 当前会话的回放与流式增量随后被绑定校验全部丢弃（消息区空白）。
  test("stale session sync response does not rebind the active session", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-B" }));
    const shared = relayOn("rcs-1");
    // 两次在途会话同步请求：id=11 为当前目标，id=10 已被用户切走
    shared.pendingSessionSyncIds = new Set([10, 11]);
    shared.latestSessionSyncRpcId = 11;

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 10,
      result: { sessionId: "ses-A" },
    } as unknown as RelayMessage);

    expect(registry.getClient("ws-1")?.acpSessionId).toBe("ses-B");
    expect(shared.replayWindowUntil).toBeNull();
    const session = sessionDoc.getMap("root").get("session") as Y.Map<unknown>;
    expect(session.get("sessionId")).toBeUndefined();
    // stale 响应同样消费登记，避免 id 空间残留
    expect(shared.pendingSessionSyncIds.has(10)).toBe(false);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 11,
      result: { sessionId: "ses-B" },
    } as unknown as RelayMessage);

    expect(registry.getClient("ws-1")?.acpSessionId).toBe("ses-B");
    expect(session.get("sessionId")).toBe("ses-B");
    expect(shared.replayWindowUntil).not.toBeNull();
  });

  // rename 响应同样携带 sessionId/title 但未经登记，不得 clobber registry 活跃会话、
  // 不得误开回放窗口、不得投影 title——否则重命名非当前会话时，活跃会话绑定被改写、
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
