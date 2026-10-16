// packages/chat-channel/src/__tests__/user-input-queue-relay.test.ts
// Peri 待发送队列（steer）relay 层收敛测试：
// ① 成功回执按 rpcId 认领（写投影），不落入会话同步分支（活跃 ACP 会话不被回绑）；
// ② status 协商能力后自动补拉一次 snapshot 并置 enabled=true；未协商不补拉、enabled=false；
// ③ -32601 等拒绝经 relay 层收敛为明确失败（原因可读、上游 message 不进日志）；
// ④ relay_closed 使全部在途 steer 请求收敛为失败；
// ⑤ 未登记的响应不认领（id 严格匹配，不吞 prompt / 会话同步的响应）。

import { describe, expect, test } from "bun:test";
import { YjsBroadcaster } from "../channel/broadcaster";
import { ConnectionRegistry } from "../channel/connection-registry";
import {
  createBoundDocs,
  createClient,
  createRelayEvents,
  createSharedRelay,
} from "../channel/connection-test-helpers";
import type { RelayMessage, SharedRelay } from "../channel/connection-types";
import { failPendingUserInputRequests, registerUserInputRequest } from "../channel/user-input-pending";
import { getSessionInfo } from "../state/chat-writer";
import { readUserInputQueue } from "../state/user-input-queue";

/** 轮询等待条件成立（status 补拉与回执写入都是异步链路） */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** 记录出站消息的共享 relay（handle 可覆写） */
function recordingRelay(relayMessages: Array<Record<string, unknown>>): SharedRelay {
  return createSharedRelay({
    rcsSessionId: "rcs-1",
    handle: {
      state: "open",
      send: (message) => {
        relayMessages.push(message as unknown as Record<string, unknown>);
      },
      close: () => {},
    },
  });
}

describe("RelayEventHandler peri steer responses", () => {
  // steer 回执同样携带 sessionId：认领必须优先于会话同步，否则 registry 活跃会话被 clobber。
  test("成功回执按 rpcId 认领并写投影，不劫持会话同步", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ rcsSessionId: "rcs-1", acpSessionId: "ses-active" }));
    const relay = recordingRelay([]);

    const request = registerUserInputRequest(relay, { rpcId: 42, kind: "snapshot" });
    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
      id: 42,
      result: { sessionId: "ses-other", generation: "gen-1", revision: 2, items: [] },
    } as unknown as RelayMessage);

    expect(await request.completed).toEqual({ ok: true });
    expect(registry.findActiveSessionIdByRcsSession("rcs-1")).toBe("ses-active");
    expect(getSessionInfo(sessionDoc).get("sessionId")).not.toBe("ses-other");
    expect(readUserInputQueue(sessionDoc).generation).toBe("gen-1");
    expect(relay.pendingUserInputRequests?.size).toBe(0);
  });

  // status 的 capabilities._meta 回显协商结果 → 必须主动补拉一次快照（读操作）并置 enabled。
  test("status 协商能力后自动补拉一次快照并置 enabled=true", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ rcsSessionId: "rcs-1", acpSessionId: "ses-1" }));
    const relayMessages: Array<Record<string, unknown>> = [];
    const relay = recordingRelay(relayMessages);

    await handler.createMessageHandler(relay)({
      type: "status",
      payload: { connected: true, capabilities: { loadSession: true, _meta: { "peri.userInputQueue": true } } },
    } as unknown as RelayMessage);

    const snapshotRequest = relayMessages.find((message) => message.method === "session/input/snapshot");
    expect(snapshotRequest).toBeDefined();
    expect(snapshotRequest?.params).toEqual({ sessionId: "ses-1" });
    // status 重复 resend 只补拉一次（同一 ACP 会话幂等）
    await handler.createMessageHandler(relay)({
      type: "status",
      payload: { connected: true, capabilities: { loadSession: true, _meta: { "peri.userInputQueue": true } } },
    } as unknown as RelayMessage);
    expect(relayMessages.filter((message) => message.method === "session/input/snapshot")).toHaveLength(1);

    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
      id: snapshotRequest?.id,
      result: { sessionId: "ses-1", generation: "gen-1", revision: 1, items: [] },
    } as unknown as RelayMessage);
    await waitFor(() => readUserInputQueue(sessionDoc).enabled);
    expect(readUserInputQueue(sessionDoc).generation).toBe("gen-1");
  });

  // 未协商（capabilities 无该键）或 status 未就绪（capabilities 为空）都不得补拉，enabled 保持 false。
  test("未协商能力不补拉且 enabled=false", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ rcsSessionId: "rcs-1", acpSessionId: "ses-1" }));
    const relayMessages: Array<Record<string, unknown>> = [];
    const relay = recordingRelay(relayMessages);

    await handler.createMessageHandler(relay)({
      type: "status",
      payload: { connected: true, capabilities: { loadSession: true } },
    } as unknown as RelayMessage);
    expect(relayMessages.filter((message) => String(message.method).startsWith("session/input/"))).toEqual([]);
    expect(readUserInputQueue(sessionDoc).enabled).toBe(false);
  });

  // 拒绝（未协商能力 / 只读 observer / 容量）经 relay 层收敛为明确失败：不悬挂、不重试。
  test("-32601 拒绝收敛为明确失败，上游 message 不进诊断日志", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const reports: Array<[string, unknown]> = [];
    const handler = createRelayEvents(registry, broadcaster, [], {
      docManager,
      reportError: (message, error) => reports.push([message, error]),
    });
    const relay = recordingRelay([]);

    const request = registerUserInputRequest(relay, { rpcId: 8, kind: "dispatch" });
    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
      id: 8,
      error: { code: -32601, message: "user input queue capability not negotiated" },
    } as unknown as RelayMessage);

    expect(await request.completed).toEqual({
      ok: false,
      reason: "rejected",
      publicErrorType: "ACTION.INVALID_STATE",
    });
    expect(reports[0]?.[0]).toBe("[YJS-FE] user input queue request rejected");
    expect(JSON.stringify(reports)).not.toContain("capability not negotiated");
  });

  // relay_closed：Agent 会话已死，回执不可达，在途 steer 必须全部收敛（同 failPendingSessionMutations 语义）。
  test("relay_closed 收敛在途 steer 请求", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const relay = recordingRelay([]);

    const request = registerUserInputRequest(relay, { rpcId: 7, kind: "enqueue" });
    await handler.createMessageHandler(relay)({ type: "relay_closed" } as RelayMessage);

    expect(await request.completed).toEqual({
      ok: false,
      reason: "relay_closed",
      publicErrorType: "ACTION.AGENT_UNAVAILABLE",
    });
    expect(relay.pendingUserInputRequests?.size).toBe(0);
  });

  // Agent 断连（可能伴随重启）后重连：必须重新补拉，否则用户带着旧 generation 重试必被拒一次。
  test("Agent 断连后重连的 status 重新补拉队列快照", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ rcsSessionId: "rcs-1", acpSessionId: "ses-1" }));
    const relayMessages: Array<Record<string, unknown>> = [];
    const relay = recordingRelay(relayMessages);
    const readyStatus = {
      type: "status",
      payload: { connected: true, capabilities: { loadSession: true, _meta: { "peri.userInputQueue": true } } },
    } as unknown as RelayMessage;

    await handler.createMessageHandler(relay)(readyStatus);
    await handler.createMessageHandler(relay)({
      type: "status",
      payload: { connected: false },
    } as unknown as RelayMessage);
    expect(relay.userInputSnapshotSessionId).toBeNull();
    await handler.createMessageHandler(relay)(readyStatus);

    expect(relayMessages.filter((message) => message.method === "session/input/snapshot")).toHaveLength(2);
    failPendingUserInputRequests(relay);
  });

  // id 严格匹配：未登记的响应不得被队列路径认领（否则会吞掉 prompt / 会话同步的收敛）。
  test("未登记的响应不被队列路径认领", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const relay = recordingRelay([]);

    const request = registerUserInputRequest(relay, { rpcId: 20, kind: "enqueue" });
    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
      id: 21,
      error: { code: -32603, message: "unrelated failure" },
    } as unknown as RelayMessage);

    expect(relay.pendingUserInputRequests?.has(20)).toBe(true);
    request.cancel();
    expect(await request.completed).toMatchObject({ ok: false });
  });
});
