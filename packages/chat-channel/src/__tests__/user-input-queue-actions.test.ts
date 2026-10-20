// packages/chat-channel/src/__tests__/user-input-queue-actions.test.ts
// Peri 待发送队列（steer）控制面动作测试（Q12 测试 seam，无真实网络、无真实 Agent）：
// ① 三个 Action 的出站帧 params 精确匹配（无多余字段；sessionId / generation / commandId
//    一律服务端权威，浏览器伪造值不参与出站）；
// ② commandId 端到端幂等（重复提交只出站一次）；
// ③ generation 缺失补拉与过期（-32602 + data.rejected）校正 + 用户可读错误；
// ④ peri MessageContent ⇄ ACP 内容块双向形状转换（图片不静默丢失、base64 不进投影）；
// ⑤ 响应超时与 relay 断连收敛（不悬挂）；⑥ 只读 observer 被拒；
// ⑦ 能力协商补拉与未协商回退（不补拉、enabled=false）。

import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { createSharedRelay } from "../channel/connection-test-helpers";
import type { SharedRelay } from "../channel/connection-types";
import { SessionChannel, type SessionChannelDependencies, type SessionConnection } from "../channel/session-channel";
import type { ActionAck, ActionError } from "../channel/types";
import { failPendingUserInputRequests, registerUserInputRequest } from "../channel/user-input-pending";
import { ensureUserInputQueueSnapshot } from "../channel/user-input-queue-action";
import {
  classifyUserInputQueueRejection,
  parseUserInputSnapshot,
  settleUserInputQueueResponse,
} from "../channel/user-input-queue-wire";
import { fromPeriMessageContent, toPeriMessageContent, translateSimpleAction } from "../protocol/translator";
import { USER_INPUT_IMAGE_PLACEHOLDER } from "../schema";
import { setUserInputQueueState } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { readUserInputQueue } from "../state/user-input-queue";

interface RelayRecord {
  jsonrpc: string;
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface Harness {
  channel: SessionChannel;
  docManager: DocManager;
  sessionDoc: Y.Doc;
  shared: SharedRelay;
  relayMessages: RelayRecord[];
  acks: ActionAck[];
  errorFrames: ActionError[];
  sinks: { sendAck: (ack: ActionAck) => void; sendError: (error: ActionError) => void };
}

/** 轮询等待条件成立（替代固定 sleep：CI 高负载下固定时长不足会导致 flaky） */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** 构造带真实 DocManager 与登记型 SharedRelay 的 SessionChannel harness */
async function createHarness(
  options: {
    generation?: string;
    dependencyOverrides?: Partial<SessionChannelDependencies>;
    connectionOverrides?: Partial<SessionConnection>;
  } = {},
): Promise<Harness & { connection: SessionConnection }> {
  const docManager = new DocManager({ onError: () => {}, onLog: () => {} });
  await docManager.openChat("rcs-1");
  const sessionDoc = (await docManager.openSession("user-1", "agent-1", "rcs-1")).ydoc;
  if (options.generation) setUserInputQueueState(sessionDoc, { generation: options.generation, revision: 1 });

  const relayMessages: RelayRecord[] = [];
  const shared = createSharedRelay({
    rcsSessionId: "rcs-1",
    handle: {
      state: "open",
      send: (message) => {
        relayMessages.push(message as unknown as RelayRecord);
      },
      close: () => {},
    },
  });
  let nextRpcId = 0;
  const connection: SessionConnection = {
    userId: "user-1",
    ownerUserId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    acpSessionId: "ses-1",
    agentStatusReceived: true,
    sessionLoaded: false,
    workspacePath: "/workspace/org-1/user-1/env-1",
    sendToRelay: (message) => {
      relayMessages.push(message as unknown as RelayRecord);
    },
    getNextRpcId: () => ++nextRpcId,
    ...options.connectionOverrides,
  };
  // 未覆写时按 gateway 装配注入在途登记（响应收敛与命令等待共用同一登记表）
  if (!connection.awaitUserInputRequest) {
    connection.awaitUserInputRequest = (rpcId, kind, timeoutMs) =>
      registerUserInputRequest(shared, { rpcId, kind, timeoutMs });
  }

  const acks: ActionAck[] = [];
  const errorFrames: ActionError[] = [];
  const channel = new SessionChannel({
    docManager,
    refreshInstanceEnvironment: async () => {},
    replaceProjection: () => {},
    syncSessionId: () => {},
    reportError: () => {},
    ...options.dependencyOverrides,
  });
  const sinks = {
    sendAck: (ack: ActionAck) => acks.push(ack),
    sendError: (error: ActionError) => errorFrames.push(error),
  };
  return { channel, docManager, sessionDoc, shared, relayMessages, acks, errorFrames, sinks, connection };
}

/** 收敛一条成功回执（等价 relay 层收到 peri 的 result 帧） */
// 成功回执：peri 的 snapshot 命令直接回快照，enqueue/dispatch/takeback 回
// UserInputQueueReceipt（{ snapshot, results, takenBack? }）——extra 用于补后两者。
function settleSuccess(
  harness: Harness,
  rpcId: number,
  snapshot: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): void {
  settleUserInputQueueResponse({
    shared: harness.shared,
    rpcId,
    rpcCheck: { id: rpcId, result: { snapshot, ...extra } },
    docManager: harness.docManager,
    reportError: () => {},
  });
}

const snapshotOf = (generation: string, revision: number, items: unknown[] = []): Record<string, unknown> => ({
  sessionId: "ses-1",
  generation,
  revision,
  items,
});

describe("SessionChannel peri steer actions", () => {
  // 出站帧的 params 是 peri 侧 deny_unknown_fields 的固定字段集：多一个字段整条被拒。
  test("enqueue 出站 params 精确匹配，浏览器伪造的权威字段不参与", async () => {
    const harness = await createHarness({ generation: "gen-1" });
    const action = harness.channel.handleAction(
      harness.connection,
      {
        action: "enqueue_user_input",
        commandId: "cmd-1",
        inputId: "in-1",
        content: "hello",
        originalDraft: "draft",
        // 浏览器伪造：sessionId / generation 必须被服务端权威值覆盖或忽略
        sessionId: "ses-evil",
        generation: "gen-evil",
      },
      harness.sinks,
    );
    await waitFor(() => harness.relayMessages.length === 1);
    expect(harness.relayMessages[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session/input/enqueue",
      params: {
        sessionId: "ses-1",
        generation: "gen-1",
        commandId: "cmd-1",
        inputId: "in-1",
        content: "hello",
        originalDraft: "draft",
      },
    });
    settleSuccess(
      harness,
      1,
      snapshotOf("gen-1", 2, [{ inputId: "in-1", content: "hello", originalDraft: "draft", state: "queued" }]),
    );
    await action;
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed"]);
    // 成功回执的权威快照已写入投影（前端据此渲染待发送项）
    expect(readUserInputQueue(harness.sessionDoc).items.map((item) => item.inputId)).toEqual(["in-1"]);
  });

  // dispatch 与 takeback 的 params 只有 inputIds / inputId 差异，其余字段集逐字一致。
  test("dispatch 与 takeback 出站 params 精确匹配", async () => {
    const harness = await createHarness({ generation: "gen-1" });
    const dispatch = harness.channel.handleAction(
      harness.connection,
      { action: "dispatch_user_inputs", commandId: "cmd-dispatch", inputIds: ["in-1", "in-2"] },
      harness.sinks,
    );
    await waitFor(() => harness.relayMessages.length === 1);
    expect(harness.relayMessages[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session/input/dispatch",
      params: { sessionId: "ses-1", generation: "gen-1", commandId: "cmd-dispatch", inputIds: ["in-1", "in-2"] },
    });
    settleSuccess(harness, 1, snapshotOf("gen-1", 2));
    await dispatch;

    const takeback = harness.channel.handleAction(
      harness.connection,
      { action: "takeback_user_input", commandId: "cmd-takeback", inputId: "in-2" },
      harness.sinks,
    );
    await waitFor(() => harness.relayMessages.length === 2);
    expect(harness.relayMessages[1]).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "session/input/takeback",
      params: { sessionId: "ses-1", generation: "gen-1", commandId: "cmd-takeback", inputId: "in-2" },
    });
    settleSuccess(harness, 2, snapshotOf("gen-1", 3), {
      takenBack: { inputId: "in-2", content: "b", originalDraft: "b" },
    });
    await takeback;
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed", "accepted", "committed"]);
  });

  // peri 的 takeback 对已不在 queued 的项不报错：回执成功但 takenBack 缺省。
  // 判定为失败：否则前端会把草稿交回输入框，而该项同时仍在投递中（同一条内容两份）。
  test("takeback 回执未携带 takenBack 时不提交（项已投递中），草稿不交回", async () => {
    const harness = await createHarness({ generation: "gen-1" });
    const takeback = harness.channel.handleAction(
      harness.connection,
      { action: "takeback_user_input", commandId: "cmd-takeback", inputId: "in-1" },
      harness.sinks,
    );
    await waitFor(() => harness.relayMessages.length === 1);
    settleSuccess(harness, 1, snapshotOf("gen-1", 4, [{ inputId: "in-1", content: "a", state: "dispatching" }]));
    await takeback;
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    expect(harness.errorFrames).toMatchObject([{ error: { type: "ACTION.INVALID_STATE" } }]);
    // 权威快照仍然写回投影（队列项仍在 dispatching，前端据此禁用取回）
    expect(readUserInputQueue(harness.sessionDoc).items.map((item) => item.state)).toEqual(["dispatching"]);
  });

  // commandId 是 peri 侧的端到端幂等键：重复提交不得重复出站（否则队列里出现两条同样的消息）。
  test("同一 commandId 重复提交只出站一次，第二次返回 duplicate", async () => {
    const harness = await createHarness({ generation: "gen-1" });
    const rawAction = { action: "enqueue_user_input", commandId: "cmd-1", inputId: "in-1", content: "a" };
    const first = harness.channel.handleAction(harness.connection, rawAction, harness.sinks);
    await waitFor(() => harness.relayMessages.length === 1);
    settleSuccess(harness, 1, snapshotOf("gen-1", 2));
    await first;

    await harness.channel.handleAction(harness.connection, rawAction, harness.sinks);
    expect(harness.relayMessages).toHaveLength(1);
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed", "duplicate"]);
  });

  // 投影尚无代号（首次入队 / 会话切换后）时必须先补拉快照，补拉不到即失败，绝不猜代号。
  test("投影无代号先补拉快照，补拉失败即失败且不发命令", async () => {
    const harness = await createHarness({
      dependencyOverrides: { userInputQueueTimeoutMs: 5 },
    });
    const action = harness.channel.handleAction(
      harness.connection,
      { action: "takeback_user_input", commandId: "cmd-1", inputId: "in-1" },
      harness.sinks,
    );
    await waitFor(() => harness.relayMessages.length === 1);
    expect(harness.relayMessages[0]?.method).toBe("session/input/snapshot");
    await action;
    expect(harness.errorFrames).toHaveLength(1);
    expect(harness.errorFrames[0]).toMatchObject({ commandId: "cmd-1", error: { type: "ACTION.AGENT_UNAVAILABLE" } });
    expect(harness.relayMessages.filter((message) => message.method === "session/input/takeback")).toHaveLength(0);
  });

  // 补拉成功时代号来自权威快照，随后命令带该代号出站。
  test("补拉成功用快照代号出站命令", async () => {
    const harness = await createHarness();
    const action = harness.channel.handleAction(
      harness.connection,
      { action: "enqueue_user_input", commandId: "cmd-1", inputId: "in-1", content: "a" },
      harness.sinks,
    );
    await waitFor(() => harness.relayMessages.length === 1);
    const snapshotRpcId = harness.relayMessages[0]?.id as number;
    settleSuccess(harness, snapshotRpcId, snapshotOf("gen-2", 4));
    await waitFor(() => harness.relayMessages.length === 2);
    expect(harness.relayMessages[1]?.method).toBe("session/input/enqueue");
    expect(harness.relayMessages[1]?.params.generation).toBe("gen-2");
    settleSuccess(harness, harness.relayMessages[1]?.id as number, snapshotOf("gen-2", 5));
    await action;
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed"]);
  });

  // generation 过期（-32602 + data.rejected）必须用回传快照校正投影，否则用户每次重试都白等。
  test("generation 过期用权威快照校正投影并以 VERSION_CONFLICT 失败", async () => {
    const harness = await createHarness({ generation: "gen-old" });
    const action = harness.channel.handleAction(
      harness.connection,
      { action: "enqueue_user_input", commandId: "cmd-1", inputId: "in-1", content: "a" },
      harness.sinks,
    );
    await waitFor(() => harness.relayMessages.length === 1);
    expect(harness.relayMessages[0]?.params.generation).toBe("gen-old");
    settleUserInputQueueResponse({
      shared: harness.shared,
      rpcId: 1,
      rpcCheck: {
        id: 1,
        error: {
          code: -32602,
          message: "generation mismatch",
          data: {
            rejected: true,
            snapshot: snapshotOf("gen-new", 9, [
              { inputId: "in-9", content: "pending", originalDraft: "", state: "queued" },
            ]),
          },
        },
      },
      docManager: harness.docManager,
      reportError: () => {},
    });
    await action;
    expect(harness.errorFrames[0]).toMatchObject({ commandId: "cmd-1", error: { type: "ACTION.VERSION_CONFLICT" } });
    const queue = readUserInputQueue(harness.sessionDoc);
    expect(queue.generation).toBe("gen-new");
    expect(queue.items.map((item) => item.inputId)).toEqual(["in-9"]);
  });

  // 只读 observer（非环境属主）可能误发 steer：服务端必须在入队前拒绝，既不 ack 也不出站。
  test("只读 observer 的 steer action 被拒且不出站", async () => {
    const harness = await createHarness({
      generation: "gen-1",
      connectionOverrides: { userId: "user-2", ownerUserId: "user-1" },
    });
    await harness.channel.handleAction(
      harness.connection,
      { action: "enqueue_user_input", commandId: "cmd-1", inputId: "in-1", content: "a" },
      harness.sinks,
    );
    expect(harness.relayMessages).toEqual([]);
    expect(harness.acks).toEqual([]);
    expect(harness.errorFrames[0]).toMatchObject({ commandId: "cmd-1", error: { type: "ACTION.FORBIDDEN" } });
  });

  // Agent 不回执时必须超时收敛为明确失败并清空登记，否则前端永远停在"发送中"。
  test("响应超时收敛为 ACTION.AGENT_UNAVAILABLE 并清空在途登记", async () => {
    const harness = await createHarness({
      generation: "gen-1",
      dependencyOverrides: { userInputQueueTimeoutMs: 5 },
    });
    await harness.channel.handleAction(
      harness.connection,
      { action: "dispatch_user_inputs", commandId: "cmd-1", inputIds: ["in-1"] },
      harness.sinks,
    );
    expect(harness.errorFrames[0]).toMatchObject({ error: { type: "ACTION.AGENT_UNAVAILABLE" } });
    expect(harness.shared.pendingUserInputRequests?.size).toBe(0);
  });

  // relay 断连（relay_closed / 引用计数归零释放）使全部在途 steer 收敛为失败，不悬挂。
  test("relay 断连收敛在途 steer 请求", async () => {
    const harness = await createHarness({ generation: "gen-1" });
    const action = harness.channel.handleAction(
      harness.connection,
      { action: "takeback_user_input", commandId: "cmd-1", inputId: "in-1" },
      harness.sinks,
    );
    await waitFor(() => harness.relayMessages.length === 1);
    expect(harness.shared.pendingUserInputRequests?.size).toBe(1);
    failPendingUserInputRequests(harness.shared);
    await action;
    expect(harness.errorFrames[0]).toMatchObject({ error: { type: "ACTION.AGENT_UNAVAILABLE" } });
    expect(harness.shared.pendingUserInputRequests?.size).toBe(0);
  });

  // 补拉能力：未协商不发请求且 enabled 保持 false（前端回退直发 prompt）；协商后补拉成功置 enabled=true。
  test("未协商能力不补拉且 enabled=false，协商后补拉成功置 enabled=true", async () => {
    const docManager = new DocManager({ onError: () => {}, onLog: () => {} });
    await docManager.openChat("rcs-1");
    const sessionDoc = (await docManager.openSession("user-1", "agent-1", "rcs-1")).ydoc;
    const relayMessages: RelayRecord[] = [];
    const shared = createSharedRelay({
      rcsSessionId: "rcs-1",
      userInputQueueCapability: false,
      handle: {
        state: "open",
        send: (message) => {
          relayMessages.push(message as unknown as RelayRecord);
        },
        close: () => {},
      },
    });

    await ensureUserInputQueueSnapshot({ shared, sessionId: "ses-1", docManager, reportError: () => {} });
    expect(relayMessages).toEqual([]);
    expect(readUserInputQueue(sessionDoc).enabled).toBe(false);

    shared.userInputQueueCapability = true;
    const pull = ensureUserInputQueueSnapshot({ shared, sessionId: "ses-1", docManager, reportError: () => {} });
    await waitFor(() => relayMessages.length === 1);
    expect(relayMessages[0]?.method).toBe("session/input/snapshot");
    settleUserInputQueueResponse({
      shared,
      rpcId: relayMessages[0]?.id as number,
      rpcCheck: { id: relayMessages[0]?.id, result: snapshotOf("gen-1", 2) },
      docManager,
      reportError: () => {},
    });
    await pull;
    const queue = readUserInputQueue(sessionDoc);
    expect(queue.enabled).toBe(true);
    expect(queue.generation).toBe("gen-1");
  });
});

describe("peri MessageContent 形状转换", () => {
  // 图片块必须转成 peri 的 base64 source（snake_case）：直接透传 ACP 形状会被拒绝或静默丢图。
  test("ACP 图片块转 peri base64 source，纯文本折叠为裸字符串", () => {
    const rpc = translateSimpleAction(
      {
        action: "enqueue_user_input",
        inputId: "in-1",
        content: [
          { type: "text", text: "看图" },
          { type: "image", mimeType: "image/png", data: "QUJD" },
        ],
        sessionId: "ses-1",
      },
      "/ws",
      7,
      { generation: "gen-1", commandId: "cmd-1" },
    );
    expect(rpc).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "session/input/enqueue",
      params: {
        sessionId: "ses-1",
        generation: "gen-1",
        commandId: "cmd-1",
        inputId: "in-1",
        content: [
          { type: "text", text: "看图" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
        // 空草稿固定补空串：deny_unknown_fields 下缺字段不可预期，空串与缺省在回填时等价
        originalDraft: "",
      },
    });
    // 纯文本（含多块文本）折叠为裸字符串，不发块数组
    expect(
      toPeriMessageContent([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
    expect(toPeriMessageContent("hi")).toBe("hi");
  });

  // 反向（takeback 回填 / 快照展示）：peri 形状还原为 ACP 形状，且往返幂等。
  test("peri 图片块还原为 ACP 形状并往返幂等", () => {
    const periImage = {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
    } as const;
    expect(fromPeriMessageContent([periImage])).toEqual([{ type: "image", mimeType: "image/jpeg", data: "QUJD" }]);
    expect(toPeriMessageContent(fromPeriMessageContent([periImage]))).toEqual([periImage]);
    expect(fromPeriMessageContent("hi")).toEqual([{ type: "text", text: "hi" }]);
    // 缺 mimeType / data 的块丢弃，不降级成文本、不发半截 base64
    expect(toPeriMessageContent([{ type: "image", mimeType: "image/png" }])).toBe("");
  });

  // 快照项的展示文本只留图片占位符：base64 不得进入 Y.Doc（Session Doc 首帧整体同步的体积）。
  test("快照项图片只投影为占位符，base64 不进入投影", () => {
    const snapshot = parseUserInputSnapshot({
      sessionId: "ses-1",
      generation: "gen-1",
      revision: 3,
      items: [
        {
          inputId: "in-1",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }],
          originalDraft: "draft",
        },
      ],
    });
    expect(snapshot?.items[0]).toEqual({
      inputId: "in-1",
      content: USER_INPUT_IMAGE_PLACEHOLDER,
      originalDraft: "draft",
      state: "unknown",
    });
    expect(JSON.stringify(snapshot)).not.toContain("QUJD");
  });

  // 拒绝归类只读 code 与稳定 data 标记（不读上游 message）：peri 四类队列侧失败共用
  // rejected 标记，换代与否只能靠权威快照代号与本地投影比对来证明。
  test("拒绝归类：换代证明为 VERSION_CONFLICT，代号相同归 RATE_LIMITED，其余 INVALID_STATE", () => {
    expect(classifyUserInputQueueRejection({ code: -32601, message: "unsupported method" })).toMatchObject({
      publicErrorType: "ACTION.INVALID_STATE",
      stale: false,
    });
    expect(classifyUserInputQueueRejection({ code: -32602, message: "read-only observer" })).toMatchObject({
      publicErrorType: "ACTION.INVALID_STATE",
      stale: false,
    });
    const rejectedWithSnapshot = (generation: string) => ({
      code: -32602,
      message: "User input queue is full",
      data: { rejected: true, snapshot: snapshotOf(generation, 3) },
    });
    // 代号不同 → 证实换代：必须写回快照纠正过期代号并提示重试
    expect(classifyUserInputQueueRejection(rejectedWithSnapshot("gen-2"), "gen-1")).toMatchObject({
      publicErrorType: "ACTION.VERSION_CONFLICT",
      stale: true,
    });
    // 本地无代号（会话 Doc 不在内存）→ 无法证伪换代，仍按换代处理
    expect(classifyUserInputQueueRejection(rejectedWithSnapshot("gen-2"), null)).toMatchObject({
      publicErrorType: "ACTION.VERSION_CONFLICT",
      stale: true,
    });
    // 代号相同（容量满 / 身份冲突 / 会话关闭）→ 不是换代失败，不得提示用户用旧代号重试
    const capacity = classifyUserInputQueueRejection(rejectedWithSnapshot("gen-1"), "gen-1");
    expect(capacity).toMatchObject({ publicErrorType: "ACTION.RATE_LIMITED", stale: false });
    expect(capacity.snapshot?.generation).toBe("gen-1");
    // message 里的 rejected 字样不参与判定（防上游文案变化导致误判为换代冲突）
    expect(classifyUserInputQueueRejection({ code: -32602, message: "rejected" })).toMatchObject({
      publicErrorType: "ACTION.INVALID_STATE",
      stale: false,
    });
  });
});
