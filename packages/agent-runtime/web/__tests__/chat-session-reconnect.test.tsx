import { afterEach, expect, test } from "bun:test";
import { type ActionAck, type ActionError, encodeYjsUpdateFrame } from "@fenix/chat-channel";
import { DocManager, SessionChannel, type SessionConnection } from "@fenix/chat-channel/server";
import { createInstance } from "i18next";
import { act } from "react";
import { initReactI18next } from "react-i18next/initReactI18next";
import * as Y from "yjs";
import {
  type FakeWebSocket,
  installFakeWebSocket,
  legacySockets,
  renderRuntime,
  restoreFakeWebSocket,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);
void createInstance().use(initReactI18next).init({ lng: "en", initAsync: false, resources: {} });

/** 只读取真实 runtime 写入 socket 的动作信封。 */
function actions(socket: FakeWebSocket, action: string): Record<string, unknown>[] {
  return socket.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .filter((frame) => frame.action === action);
}

/** 使用服务端实际代次完成命令连接握手。 */
function connect(socket: FakeWebSocket, epoch: string): void {
  act(() => {
    socket.open();
    socket.onmessage?.({ data: JSON.stringify({ type: "yjs:command-epoch", epoch }) } as MessageEvent);
  });
}

// 恢复是新连接的绑定意图；旧 load/resume 的回执丢失不能使重连只得到去重回执。
test.each(
  (["load_session", "resume_session"] as const).flatMap((action) =>
    [false, true].map((restart) => [action, restart] as const),
  ),
)("%s 回执丢失后重新确认绑定（服务重启=%s）", async (action, restart) => {
  installFakeWebSocket();
  const h = renderRuntime();
  const manager = new DocManager({ acpBatchWindowMs: 0 });
  const key = h.latest.current!.rcsSessionKey!;
  const relay: Record<string, unknown>[] = [];
  const acks: ActionAck[] = [];
  const errors: ActionError[] = [];
  const continuity = {};
  let rpcId = 0;
  const channel = () =>
    new SessionChannel({
      docManager: manager,
      replaceProjection: () => {},
      syncSessionId: () => {},
      reportError: () => {},
    });
  const connection = (): SessionConnection => ({
    userId: "user-1",
    agentId: "env-1",
    instanceId: "inst-1",
    rcsSessionId: key,
    acpSessionId: "ses-existing",
    sessionLoaded: false,
    agentStatusReceived: true,
    workspacePath: "/trusted-workspace",
    runtimeIdentity: "runtime-1",
    getSessionContinuity: () => continuity,
    sendToRelay: (frame) => {
      relay.push(frame);
      if (frame.method === "session/load" || frame.method === "session/resume") {
        manager.processNormalizedEvent(key, {
          type: "session_updated",
          update: { sessionId: (frame.params as Record<string, unknown>).sessionId },
          content: null,
        });
      }
    },
    getNextRpcId: () => ++rpcId,
    awaitSessionMutation: () => ({ completed: Promise.resolve(true), cancel: () => {} }),
  });
  const sinks = { sendAck: (ack: ActionAck) => acks.push(ack), sendError: (error: ActionError) => errors.push(error) };
  let server = channel();
  try {
    await manager.openChat(key);
    await manager.openSession("user-1", "env-1", key);
    const first = legacySockets()[0]!;
    connect(first, server.getCommandEpoch());
    const restore = () =>
      action === "load_session"
        ? h.latest.current!.callbacks.onLoadSession("ses-existing")
        : h.latest.current!.callbacks.onResumeSession("ses-existing");
    act(() => {
      restore();
    });
    const original = actions(first, action).at(-1)!;
    expect(original).toMatchObject({ action, sessionId: "ses-existing" });
    act(() => {
      restore();
    });
    expect(actions(first, action).at(-1)?.commandId).toBe(original.commandId);
    await server.handleClientAction(connection(), original, sinks);
    expect(acks.at(-1)?.status).toBe("committed");
    // 将新投影交付客户端，但有意不交付 committed Ack，模拟断线边界的真实丢帧。
    const doc = manager.getSessionYdoc(key)!;
    act(() =>
      first.onmessage?.({
        data: encodeYjsUpdateFrame(`session:${key}`, "generation-existing", Y.encodeStateAsUpdate(doc)),
      } as MessageEvent),
    );
    act(() => first.closeFromServer(1006, "connection_lost"));
    server.disposeRcsSession(key);
    if (restart) server = channel();
    await act(async () => {
      await Bun.sleep(1100);
    });
    const next = legacySockets().at(-1)!;
    expect(next).not.toBe(first);
    connect(next, server.getCommandEpoch());
    act(() => {
      restore();
    });
    const renewed = actions(next, action).at(-1)!;
    expect(renewed).toMatchObject({ action, sessionId: "ses-existing" });
    const current = connection();
    await server.handleClientAction(current, renewed, sinks);
    expect(current.sessionLoaded).toBe(true);
    expect(renewed.commandId).not.toBe(original.commandId);
    expect(String(renewed.commandId).split(".")[0]).toBe(server.getCommandEpoch());
    expect(
      relay.filter((frame) => frame.method === (action === "load_session" ? "session/load" : "session/resume")),
    ).toHaveLength(restart ? 2 : 1);
    act(() => h.latest.current!.callbacks.onSendPrompt([{ type: "text", text: "恢复后继续" }]));
    const prompt = actions(next, "send_prompt").at(-1)!;
    await server.handleClientAction(current, prompt, sinks);
    expect(errors).toEqual([]);
    expect(acks.at(-1)?.status).toBe("committed");
    expect(relay.at(-1)).toMatchObject({ method: "session/prompt", params: { sessionId: "ses-existing" } });
  } finally {
    h.unmount();
    server.disposeRcsSession(key);
    await manager.closeAll();
  }
});

// 连接重建仅结束绑定恢复意图，结果未知的用户输入仍须使用原幂等键。
test("重连不释放未知 prompt 的完整 commandId", async () => {
  installFakeWebSocket();
  const h = renderRuntime();
  const content = [{ type: "text", text: "不能重复执行" }];
  try {
    const first = legacySockets()[0]!;
    connect(first, "11111111-1111-4111-8111-111111111111");
    act(() => h.latest.current!.callbacks.onSendPrompt(content));
    const original = actions(first, "send_prompt").at(-1)!;
    act(() => first.closeFromServer(1006, "connection_lost"));
    await act(async () => {
      await Bun.sleep(1100);
    });
    const next = legacySockets().at(-1)!;
    connect(next, "22222222-2222-4222-8222-222222222222");
    expect(actions(next, "send_prompt")).toEqual([]);
    expect(h.latest.current!.preservedPrompt).toMatchObject({ commandId: original.commandId, outcomeUnknown: true });
    act(() => h.latest.current!.callbacks.onSendPrompt(content));
    expect(actions(next, "send_prompt").at(-1)?.commandId).toBe(original.commandId);
  } finally {
    h.unmount();
  }
});

// 主动重建会屏蔽旧 socket 的 close 回调，新连接开始时同样必须重新建立恢复意图。
test.each(["load_session", "resume_session"])("历史同步重试重新分配 %s 身份", (action) => {
  installFakeWebSocket();
  const h = renderRuntime();
  const epoch = "11111111-1111-4111-8111-111111111111";
  const restore = () =>
    action === "load_session"
      ? h.latest.current!.callbacks.onLoadSession("ses-existing")
      : h.latest.current!.callbacks.onResumeSession("ses-existing");
  try {
    const first = legacySockets()[0]!;
    connect(first, epoch);
    act(() => {
      restore();
    });
    const original = actions(first, action).at(-1)!;
    act(() =>
      first.onmessage?.({
        data: JSON.stringify({
          type: "yjs:history-incomplete",
          generation: "generation-existing",
          docs: [`chat:${h.latest.current!.rcsSessionKey!}`],
          reason: "backpressure",
          bytes: 0,
          limitBytes: 8 * 1024 * 1024,
        }),
      } as MessageEvent),
    );
    act(() => h.latest.current!.retryHistoryRecovery());
    const next = legacySockets().at(-1)!;
    expect(next).not.toBe(first);
    connect(next, epoch);
    act(() => {
      restore();
    });
    expect(actions(next, action).at(-1)?.commandId).not.toBe(original.commandId);
  } finally {
    h.unmount();
  }
});
