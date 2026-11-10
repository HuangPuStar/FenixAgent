import { expect, test } from "bun:test";
import * as Y from "yjs";
import { YjsBroadcaster } from "../channel/broadcaster";
import { ConnectionRegistry } from "../channel/connection-registry";
import { createClient, createRelayEvents, createSharedRelay } from "../channel/connection-test-helpers";
import type { RelayMessage, SharedRelay } from "../channel/connection-types";
import {
  createConnection,
  createHarness,
  createSinks,
  type RelayRecord,
  type TestHarness,
} from "../channel/session-channel-action-test-helpers";
import { type NormalizedEvent, USER_INPUT_IMAGE_PLACEHOLDER } from "../schema";
import { getEntriesMap, getEntry, readActiveTurn } from "../state/chat-writer";

/** 真实单像素 PNG（与服务端收到的 ACP image block 同形） */
const IMAGE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPfoAAAAASUVORK5CYII=";

const imageBlock = (): Record<string, unknown> => ({
  type: "image",
  mimeType: "image/png",
  data: IMAGE_PNG,
});

const RCS_SESSION_ID = "rcs-1";
const ACP_SESSION_ID = "ses-1";

interface PromptRig {
  harness: TestHarness;
  shared: SharedRelay;
  onMessage: (message: RelayMessage) => Promise<void>;
  connection: ReturnType<typeof createConnection>["connection"];
  relayMessages: RelayRecord[];
  syncEvents: NormalizedEvent[];
  published: Array<{ turnId: string; text: string }>;
}

/** 原 SessionChannel + DocManager + RelayEventHandler 装配（无 mock.module）。 */
async function createRig(): Promise<PromptRig> {
  const published: Array<{ turnId: string; text: string }> = [];
  const harness = createHarness({
    publishUserMessage: (_rcsSessionId, turnId, text) => published.push({ turnId, text }),
  });
  await harness.docManager.openChat(RCS_SESSION_ID);
  await harness.docManager.openSession("user-1", "agent-1", RCS_SESSION_ID);

  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  registry.addClient("ws-1", createClient({ acpSessionId: ACP_SESSION_ID }));
  const shared = createSharedRelay({ replayWindowUntil: null });
  const syncEvents: NormalizedEvent[] = [];
  const relayEvents = createRelayEvents(registry, broadcaster, [], {
    docManager: harness.docManager,
    onNormalizedEvent: (_rcsSessionId, event) => syncEvents.push(event),
  });

  // 与生产 gateway 同形登记：prompt 终态按 rpcId 回填 turnId 才能归属到本轮。
  const { connection, relayMessages } = createConnection({
    registerPendingPrompt: (rpcId, turnId) => {
      if (!shared.pendingPromptIds) shared.pendingPromptIds = new Set();
      shared.pendingPromptIds.add(rpcId);
      if (!turnId) return;
      shared.liveTurnId = turnId;
      if (!shared.pendingPromptTurns) shared.pendingPromptTurns = new Map();
      shared.pendingPromptTurns.set(rpcId, turnId);
    },
  });

  return {
    harness,
    shared,
    onMessage: relayEvents.createMessageHandler(shared),
    connection,
    relayMessages,
    syncEvents,
    published,
  };
}

interface SentPrompt {
  turnId: string;
  rpcId: number;
}

async function sendPrompt(rig: PromptRig, content: unknown, commandId: string): Promise<SentPrompt> {
  await rig.harness.channel.handleAction(
    rig.connection,
    {
      sessionId: ACP_SESSION_ID,
      action: "send_prompt",
      commandId,
      content,
    },
    createSinks(rig.harness),
  );
  const committed = rig.harness.acks.filter((ack) => ack.status === "committed").at(-1);
  const sent = rig.relayMessages.at(-1);
  if (!committed?.turnId || !sent) throw new Error("send_prompt was not committed with a turn");
  return { turnId: committed.turnId, rpcId: sent.id };
}

async function sendUserEcho(rig: PromptRig, content: unknown): Promise<void> {
  await rig.onMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: ACP_SESSION_ID, update: { sessionUpdate: "user_message_chunk", content } },
  } as unknown as RelayMessage);
}

/** message_delta 走 16ms 微批次合并，断言前等待 flush */
const waitFlush = () => new Promise((resolve) => setTimeout(resolve, 30));

async function sendAssistantDelta(rig: PromptRig, text: string): Promise<void> {
  await rig.onMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: ACP_SESSION_ID,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  } as unknown as RelayMessage);
  await waitFlush();
}

async function completePrompt(rig: PromptRig, rpcId: number): Promise<void> {
  await rig.onMessage({ jsonrpc: "2.0", id: rpcId, result: { stopReason: "end_turn" } } as unknown as RelayMessage);
}

function readEntryText(entry: Y.Map<unknown>): string {
  const blocks = entry.get("blocks") as Y.Map<Y.Map<unknown>> | undefined;
  const order = (entry.get("blockOrder") as Y.Array<string> | undefined)?.toArray() ?? [];
  return order
    .map((blockId) => {
      const text = blocks?.get(blockId)?.get("text");
      return text instanceof Y.Text ? text.toString() : "";
    })
    .join("\n");
}

function entriesOfRole(
  ydoc: Y.Doc,
  role: "user" | "assistant",
): Array<{ entryId: string; turnId: unknown; text: string }> {
  const out: Array<{ entryId: string; turnId: unknown; text: string }> = [];
  for (const [entryId, entry] of getEntriesMap(ydoc).entries()) {
    if (entry.get("role") !== role) continue;
    out.push({ entryId, turnId: entry.get("turnId"), text: readEntryText(entry) });
  }
  return out;
}

function callbackEntryIds(ydoc: Y.Doc): string[] {
  return Array.from(getEntriesMap(ydoc).keys()).filter((entryId) => entryId.startsWith("callback_"));
}

/** 模拟刷新：把内存 Chat/Session Doc 序列化为新 Doc，验证快照不重复。 */
function reloadProjection(rig: PromptRig): { chat: Y.Doc; session: Y.Doc } {
  const chat = new Y.Doc();
  Y.applyUpdate(chat, Y.encodeStateAsUpdate(rig.harness.docManager.getChatYdoc(RCS_SESSION_ID) as Y.Doc));
  const session = new Y.Doc();
  Y.applyUpdate(session, Y.encodeStateAsUpdate(rig.harness.docManager.getSessionYdoc(RCS_SESSION_ID) as Y.Doc));
  return { chat, session };
}

function chatDoc(rig: PromptRig): Y.Doc {
  return rig.harness.docManager.getChatYdoc(RCS_SESSION_ID) as Y.Doc;
}

function sessionDoc(rig: PromptRig): Y.Doc {
  return rig.harness.docManager.getSessionYdoc(RCS_SESSION_ID) as Y.Doc;
}

async function disposeRig(rig: PromptRig): Promise<void> {
  rig.harness.channel.disposeRcsSession(RCS_SESSION_ID);
  await rig.harness.docManager.closeAll();
}

interface Scenario {
  content: unknown;
  displayText: string;
  /** Agent 回显帧（按内容块逐个投递；纯图片 Agent 可只发助手增量，此处为空） */
  echoBlocks: unknown[];
}

/**
 * 单轮验收：prompt 原样发送、唯一可写 turn、用户条目、助手增量、终态收敛、刷新不重复。
 * previousTurn=true 时先完成一轮普通文本对话，验证上一轮完成后纯图/混合输入仍能建立新 turn。
 */
async function runScenario(scenario: Scenario, options: { previousTurn?: boolean } = {}): Promise<void> {
  const rig = await createRig();
  try {
    const completedTurns: string[] = [];
    if (options.previousTurn) {
      const previous = await sendPrompt(rig, [{ type: "text", text: "previous question" }], "cmd-previous");
      await sendAssistantDelta(rig, "previous answer");
      await completePrompt(rig, previous.rpcId);
      completedTurns.push(previous.turnId);
      expect(readActiveTurn(sessionDoc(rig)).turnStatus).toBe("completed");
    }

    const sent = await sendPrompt(rig, scenario.content, options.previousTurn ? "cmd-image" : "cmd-first");

    // prompt 原样转发（不因展示摘要注入文字）
    expect(rig.relayMessages.at(-1)?.method).toBe("session/prompt");
    expect(rig.relayMessages.at(-1)?.params.content).toEqual(scenario.content);

    // 恰好一个可写 turn，且与 committed 回执、用户条目、新同步投影共享同一 turnId
    const active = readActiveTurn(sessionDoc(rig));
    expect(active.turnId).toBe(sent.turnId);
    expect(["accepting", "running"]).toContain(active.turnStatus as string);
    const userEntries = entriesOfRole(chatDoc(rig), "user");
    expect(userEntries).toHaveLength(1 + completedTurns.length);
    expect(userEntries.filter((entry) => entry.turnId === sent.turnId)).toEqual([
      { entryId: `${sent.turnId}:user`, turnId: sent.turnId, text: scenario.displayText },
    ]);
    expect(rig.published.at(-1)).toEqual({ turnId: sent.turnId, text: scenario.displayText });

    // Agent 回显不得复制用户条目，也不得凭空建立 callback 对
    for (const block of scenario.echoBlocks) await sendUserEcho(rig, block);
    expect(entriesOfRole(chatDoc(rig), "user")).toHaveLength(1 + completedTurns.length);
    expect(callbackEntryIds(chatDoc(rig))).toEqual([]);
    expect(readActiveTurn(sessionDoc(rig)).turnId).toBe(sent.turnId);

    // 助手增量可写且进入新同步旁路（同一 turnId）
    await sendAssistantDelta(rig, "I can see it.");
    expect(entriesOfRole(chatDoc(rig), "assistant")).toEqual([
      ...completedTurns.map((turnId) => ({ entryId: `${turnId}:assistant`, turnId, text: "previous answer" })),
      { entryId: `${sent.turnId}:assistant`, turnId: sent.turnId, text: "I can see it." },
    ]);
    expect(readActiveTurn(sessionDoc(rig)).turnStatus).toBe("running");
    expect(rig.syncEvents.filter((event) => event.type === "message_delta").at(-1)?.turnId).toBe(sent.turnId);

    // 完成事件按 pendingPromptTurns 归属并收敛
    await completePrompt(rig, sent.rpcId);
    expect(readActiveTurn(sessionDoc(rig)).turnStatus).toBe("completed");
    expect(rig.syncEvents.filter((event) => event.type === "turn_completed").at(-1)?.turnId).toBe(sent.turnId);

    // 刷新恢复：快照条目不多不少，用户意图与助手回复都归属本轮
    const reloaded = reloadProjection(rig);
    expect(entriesOfRole(reloaded.chat, "user")).toHaveLength(1 + completedTurns.length);
    expect(callbackEntryIds(reloaded.chat)).toEqual([]);
    const reloadedUser = entriesOfRole(reloaded.chat, "user").find((entry) => entry.turnId === sent.turnId);
    expect(reloadedUser?.text).toBe(scenario.displayText);
    expect(getEntry(reloaded.chat, `${sent.turnId}:assistant`)?.get("status")).toBe("completed");
    expect(readEntryText(getEntry(reloaded.chat, `${sent.turnId}:assistant`) as Y.Map<unknown>)).toBe("I can see it.");
    expect(readActiveTurn(reloaded.session)).toEqual({ turnId: sent.turnId, turnStatus: "completed" });
  } finally {
    await disposeRig(rig);
  }
}

// 纯图片首次发送且 Agent 不回显：仍建立 turn，助手增量与终态正常投影。
test("image-only prompt opens a writable turn for assistant-only agents", async () => {
  await runScenario({
    content: [imageBlock()],
    displayText: USER_INPUT_IMAGE_PLACEHOLDER,
    echoBlocks: [],
  });
});

// 纯图片首次发送且 Agent 回显图片块：回显按展示摘要去重，不复制用户条目。
test("image-only prompt is not duplicated by an image-block echo", async () => {
  await runScenario({
    content: [imageBlock()],
    displayText: USER_INPUT_IMAGE_PLACEHOLDER,
    echoBlocks: [imageBlock()],
  });
});

// 上一轮已完成后的纯图片：新 prompt 必须重新建立可写 turn，而不是复用终态 turn。
test("image-only prompt after a completed turn opens a new writable turn", async () => {
  await runScenario(
    {
      content: [imageBlock()],
      displayText: USER_INPUT_IMAGE_PLACEHOLDER,
      echoBlocks: [imageBlock()],
    },
    { previousTurn: true },
  );
});

// 图文混合且 Agent 只发助手增量：展示文本保留文本块与图片占位，turn 生命周期不变。
test("text plus image prompt keeps a writable turn for assistant-only agents", async () => {
  await runScenario({
    content: [{ type: "text", text: "look at this" }, imageBlock()],
    displayText: `look at this\n${USER_INPUT_IMAGE_PLACEHOLDER}`,
    echoBlocks: [],
  });
});

// 图文混合且 Agent 只回显文本块：按展示片段去重，不得因整条文本含占位而复制用户气泡。
test("text plus image prompt drops the text-block echo without duplicating the user entry", async () => {
  await runScenario({
    content: [{ type: "text", text: "look at this" }, imageBlock()],
    displayText: `look at this\n${USER_INPUT_IMAGE_PLACEHOLDER}`,
    echoBlocks: [{ type: "text", text: "look at this" }],
  });
});

// 图片加引用且 Agent 只发助手增量：引用块与图片都进入展示摘要，turn 与回复可见。
test("image with quote keeps a writable turn for assistant-only agents", async () => {
  await runScenario({
    content: [
      { type: "text", text: "<system-reminder>\nquoted context\n</system-reminder>" },
      { type: "text", text: "what is this" },
      imageBlock(),
    ],
    displayText: `<system-reminder>\nquoted context\n</system-reminder>\nwhat is this\n${USER_INPUT_IMAGE_PLACEHOLDER}`,
    echoBlocks: [],
  });
});

// 图片加引用且 Agent 按内容块逐个回显：每个文本块都能命中回显去重，不产生重复条目。
test("image with quote drops per-block echoes without duplicating the user entry", async () => {
  await runScenario({
    content: [
      { type: "text", text: "<system-reminder>\nquoted context\n</system-reminder>" },
      { type: "text", text: "what is this" },
      imageBlock(),
    ],
    displayText: `<system-reminder>\nquoted context\n</system-reminder>\nwhat is this\n${USER_INPUT_IMAGE_PLACEHOLDER}`,
    echoBlocks: [
      { type: "text", text: "<system-reminder>\nquoted context\n</system-reminder>" },
      { type: "text", text: "what is this" },
      imageBlock(),
    ],
  });
});

// 真正空 content：确定地创建一个空展示用户条目与可写 turn，助手回复仍可见且刷新不重复。
test("empty prompt content still opens exactly one user entry and writable turn", async () => {
  await runScenario({
    content: [],
    displayText: "",
    echoBlocks: [],
  });
});
