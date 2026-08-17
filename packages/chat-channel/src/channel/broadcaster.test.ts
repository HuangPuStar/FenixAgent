// packages/chat-channel/src/channel/broadcaster.test.ts
// YjsBroadcaster 测试（C6 迁移自 src/__tests__/yjs-frontend-broadcaster.test.ts）：
// 按 rcsSessionId 广播隔离、二进制帧（SP-A4）、单次编码共享、帧体积对比、
// 慢消费者背压定向追赶与超时关闭（SP-A7）、SP-0 帧打点、snapshot 语义、
// 同 tick 合并、注销后停止广播、chat/session 独立帧。

import { afterEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { encodeYjsUpdateFrame, YJS_UPDATE_FRAME_TYPE } from "../protocol/update-frame";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createWs, decodeUpdateFrames, type MockWs } from "./connection-test-helpers";
import type { ClientConnection } from "./connection-types";

/** 背压阈值与实现保持一致（64KB，CLAUDE.md YJS 不变量 9） */
const WS_SEND_THRESHOLD = 64 * 1024;
/** lagging 超时关闭阈值（SP-A7：30s） */
const LAGGING_CLOSE_TIMEOUT_MS = 30_000;

function addClient(registry: ConnectionRegistry, wsId: string, ws: MockWs, rcsSessionId: string): void {
  registry.addClient(wsId, {
    ws,
    rcsSessionId,
  } as unknown as ClientConnection);
}

/** 驱动一轮微任务 flush（与生产 broadcast 相同的 queueMicrotask 时序） */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

describe("YjsBroadcaster 二进制帧（SP-A4）", () => {
  // Chat Doc 增量只能发送给同一 RCS session 的连接，不能串到其他会话（广播隔离）。
  test("isolates update frames by RCS session", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const targetWs = createWs();
    const otherWs = createWs();
    addClient(registry, "target", targetWs, "rcs-target");
    addClient(registry, "other", otherWs, "rcs-other");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-target");

    doc.getMap("chat").set("message", "only target");
    await flushMicrotasks();

    expect(decodeUpdateFrames(targetWs)).toHaveLength(1);
    expect(decodeUpdateFrames(otherWs)).toHaveLength(0);
  });

  // 广播帧必须只编码一次：同一帧对象发给所有客户端（SP-A4 序列化去重的行为锚点）。
  test("broadcasts a single encoded frame object to every client", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws1 = createWs();
    const ws2 = createWs();
    addClient(registry, "ws-1", ws1, "rcs-1");
    addClient(registry, "ws-2", ws2, "rcs-1");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-1");

    doc.getMap("chat").set("message", "shared frame");
    await flushMicrotasks();

    const binary1 = ws1.messages.filter((message): message is Uint8Array => typeof message !== "string");
    const binary2 = ws2.messages.filter((message): message is Uint8Array => typeof message !== "string");
    expect(binary1).toHaveLength(1);
    expect(binary2).toHaveLength(1);
    // 同一对象引用：证明编码/序列化只发生一次，而非每连接重复
    expect(binary1[0]).toBe(binary2[0]);
  });

  // 帧体积验收（SP-A4）：同等 update 的二进制帧显著小于历史 base64+JSON 文本帧（≈75%）。
  test("binary frames are at most 80% of the legacy base64 JSON frame size", () => {
    const doc = new Y.Doc();
    doc.getMap("chat").set("content", "x".repeat(8192));
    const update = Y.encodeStateAsUpdate(doc);
    const docName = "chat:rcs-1";

    const binaryFrame = encodeYjsUpdateFrame(docName, update);
    const legacyJsonBytes = Buffer.byteLength(
      JSON.stringify({ type: "yjs:update", docName, data: Buffer.from(update).toString("base64") }),
      "utf8",
    );

    // base64 膨胀 4/3，二进制帧仅增加 3+docNameLen 字节头；留 5% 余量抗 yjs 编码微差
    expect(binaryFrame.length).toBeLessThanOrEqual(Math.floor(legacyJsonBytes * 0.8));
  });

  // 初始 snapshot 与增量必须使用同一 0x01 二进制帧布局，且 apply 后状态等价。
  test("sends snapshots in the binary update frame layout", () => {
    const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
    const ws = createWs();
    const doc = new Y.Doc();
    doc.getMap("chat").set("title", "snapshot");

    broadcaster.sendSnapshot(ws, doc, "chat:rcs-1");

    const frames = decodeUpdateFrames(ws);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.docName).toBe("chat:rcs-1");
    expect(ws.messages[0]).toBeInstanceOf(Uint8Array);
    expect((ws.messages[0] as Uint8Array)[0]).toBe(YJS_UPDATE_FRAME_TYPE);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, frames[0]!.update);
    expect(restored.getMap("chat").get("title")).toBe("snapshot");
  });

  // 同一 tick 内同一 Doc 的两次更新必须合并为一帧，且解码后状态等价。
  test("merges same-tick updates for one document", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    addClient(registry, "ws-1", ws, "rcs-1");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-1");

    doc.getMap("chat").set("first", "one");
    doc.getMap("chat").set("second", "two");
    await flushMicrotasks();

    const frames = decodeUpdateFrames(ws);
    expect(frames).toHaveLength(1);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, frames[0]!.update);
    expect(restored.getMap("chat").toJSON()).toEqual(doc.getMap("chat").toJSON());
  });

  // unregister 后旧 Doc 的更新不能继续广播（防僵尸监听器）。
  test("stops broadcasting updates from an unregistered document", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    addClient(registry, "ws-1", ws, "rcs-1");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-1");

    broadcaster.unregisterYjsDocListener("chat:rcs-1");
    doc.getMap("chat").set("message", "stale update");
    await flushMicrotasks();

    expect(ws.messages).toHaveLength(0);
  });

  // 同一 RCS session 下 chat 与 session 属于不同 Doc，不能被合并为同一帧。
  test("keeps chat and session updates as separate frames", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    addClient(registry, "ws-1", ws, "rcs-1");
    const chatDoc = new Y.Doc();
    const sessionDoc = new Y.Doc();
    broadcaster.registerYjsDocListener(chatDoc, "chat:rcs-1");
    broadcaster.registerYjsDocListener(sessionDoc, "session:rcs-1");

    chatDoc.getMap("chat").set("title", "chat");
    sessionDoc.getMap("session").set("message", "session");
    await flushMicrotasks();

    expect(
      decodeUpdateFrames(ws)
        .map((frame) => frame.docName)
        .sort(),
    ).toEqual(["chat:rcs-1", "session:rcs-1"]);
  });

  // 控制消息（keep_alive 等）保持 JSON 文本帧，与二进制 yjs:update 帧分道传输。
  test("keeps control messages as JSON text frames", () => {
    const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
    const ws = createWs();

    broadcaster.sendToYjsWs(ws, { type: "keep_alive" });

    expect(ws.messages).toHaveLength(1);
    expect(typeof ws.messages[0]).toBe("string");
    expect(JSON.parse(ws.messages[0] as string)).toEqual({ type: "keep_alive" });
  });
});

describe("YjsBroadcaster 背压定向追赶（SP-A7）", () => {
  const originalDateNow = Object.getOwnPropertyDescriptor(Date, "now");
  let now = 1_000_000;

  function installFakeClock(): void {
    now = 1_000_000;
    Object.defineProperty(Date, "now", { configurable: true, value: () => now });
  }

  afterEach(() => {
    if (originalDateNow) {
      Object.defineProperty(Date, "now", originalDateNow);
    }
  });

  // 缓冲区超过 64KB 的慢连接跳过 yjs:update 帧并登记 lagging（不再静默丢弃），
  // 恢复依赖确定性的定向快照追赶而非"下次重连"。
  test("skips update frames over the threshold and marks the connection for resync", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const slowWs = createWs(WS_SEND_THRESHOLD + 1);
    const fastWs = createWs();
    addClient(registry, "slow", slowWs, "rcs-1");
    addClient(registry, "fast", fastWs, "rcs-1");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-1");

    doc.getMap("chat").set("message", "dropped for slow consumer");
    await flushMicrotasks();

    // 慢连接零 yjs 帧；快连接正常收到
    expect(decodeUpdateFrames(slowWs)).toHaveLength(0);
    expect(decodeUpdateFrames(fastWs)).toHaveLength(1);
  });

  // lagging 连接在 bufferedAmount 回落后必须收到定向全量快照（apply 后与源 doc 一致），
  // 且快照只发给 lagging 连接——正常连接不收到多余帧（非广播）。
  test("sends a targeted snapshot to the lagging connection after the buffer drains", async () => {
    installFakeClock();
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const slowWs = createWs(WS_SEND_THRESHOLD + 1);
    const fastWs = createWs();
    addClient(registry, "slow", slowWs, "rcs-1");
    addClient(registry, "fast", fastWs, "rcs-1");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-1");

    doc.getMap("chat").set("message", "missed while lagging");
    await flushMicrotasks();
    expect(decodeUpdateFrames(slowWs)).toHaveLength(0);

    // 缓冲回落 + 丢帧后源 doc 又有新内容：追赶快照必须覆盖到最新状态
    doc.getMap("chat").set("later", "written while lagging");
    await flushMicrotasks();

    slowWs.bufferedAmount = 0;
    // 控制帧发送（keepalive 周期）触发惰性 reconcile
    broadcaster.sendToYjsWs(fastWs, { type: "keep_alive" });

    const slowFrames = decodeUpdateFrames(slowWs);
    expect(slowFrames).toHaveLength(1);
    expect(slowFrames[0]?.docName).toBe("chat:rcs-1");
    const restored = new Y.Doc();
    Y.applyUpdate(restored, slowFrames[0]!.update);
    expect(restored.getMap("chat").toJSON()).toEqual(doc.getMap("chat").toJSON());
    // 非 lagging 连接不收到定向快照：二进制帧数量保持在两次广播增量
    expect(decodeUpdateFrames(fastWs)).toHaveLength(2);
    expect(fastWs.messages.at(-1)).toBeDefined();
    expect(typeof fastWs.messages.at(-1)).toBe("string"); // 只有 keep_alive 文本帧
  });

  // 持续 lagging 超过 30s 必须被 close(1013)（客户端重连走全量同步），
  // 其余连接不受影响（单连接故障隔离，CLAUDE.md 不变量 9）。
  test("closes a persistently lagging connection and keeps others healthy", async () => {
    installFakeClock();
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const slowWs = createWs(WS_SEND_THRESHOLD + 1);
    const fastWs = createWs();
    addClient(registry, "slow", slowWs, "rcs-1");
    addClient(registry, "fast", fastWs, "rcs-1");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-1");

    doc.getMap("chat").set("message", "never delivered");
    await flushMicrotasks();
    expect(slowWs.closed).toHaveLength(0);

    // 超时前仍在等待追赶
    now += LAGGING_CLOSE_TIMEOUT_MS - 1_000;
    broadcaster.sendToYjsWs(fastWs, { type: "keep_alive" });
    expect(slowWs.closed).toHaveLength(0);

    // 超过 30s 仍拥塞：close(1013)，其余连接照常收到 keep_alive 且不被关闭
    now += 2_000;
    broadcaster.sendToYjsWs(fastWs, { type: "keep_alive" });

    expect(slowWs.closed).toEqual([[1013, "slow consumer resync timeout"]]);
    expect(decodeUpdateFrames(slowWs)).toHaveLength(0);
    expect(fastWs.closed).toHaveLength(0);
    expect(fastWs.messages.filter((message) => typeof message === "string")).toHaveLength(2);
  });

  // 追赶依赖的 doc 注销后（relay 释放 / 实例回收）不得再构造追赶快照，
  // 残余登记被清除，后续该连接行为回到普通路径。
  test("drops pending resync entries when the document is unregistered", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const slowWs = createWs(WS_SEND_THRESHOLD + 1);
    addClient(registry, "slow", slowWs, "rcs-1");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-1");

    doc.getMap("chat").set("message", "dropped");
    await flushMicrotasks();
    broadcaster.unregisterYjsDocListener("chat:rcs-1");
    slowWs.bufferedAmount = 0;

    broadcaster.sendToYjsWs(slowWs, { type: "keep_alive" });

    // 无 doc 可追赶：不产生二进制帧，控制帧正常送达
    expect(decodeUpdateFrames(slowWs)).toHaveLength(0);
    expect(slowWs.messages.filter((message) => typeof message === "string")).toHaveLength(1);
  });
});

describe("YjsBroadcaster 帧打点（SP-0）", () => {
  const originalDateNow = Object.getOwnPropertyDescriptor(Date, "now");

  afterEach(() => {
    if (originalDateNow) {
      Object.defineProperty(Date, "now", originalDateNow);
    }
  });

  // 帧打点按 docName 前缀每秒聚合输出帧数与字节数，且绝不包含会话内容
  // （SP-0 验收：尺寸/耗时/ID only）。
  test("reports per-prefix frame counts and byte sizes without leaking content", async () => {
    let now = 1_000_000;
    Object.defineProperty(Date, "now", { configurable: true, value: () => now });
    const registry = new ConnectionRegistry();
    const logs: string[] = [];
    const broadcaster = new YjsBroadcaster(registry, { reportLog: (message) => logs.push(message) });
    const ws = createWs();
    addClient(registry, "ws-1", ws, "rcs-1");
    const chatDoc = new Y.Doc();
    const sessionDoc = new Y.Doc();
    broadcaster.registerYjsDocListener(chatDoc, "chat:rcs-1");
    broadcaster.registerYjsDocListener(sessionDoc, "session:rcs-1");

    chatDoc.getMap("chat").set("secret-chat-content", "chat-payload-marker");
    sessionDoc.getMap("session").set("secret-session-content", "session-payload-marker");
    await flushMicrotasks();

    // 窗口内不打点；跨过 1s 窗口后的下一帧触发上一窗口聚合输出
    now += 1_100;
    chatDoc.getMap("chat").set("next", "frame");
    await flushMicrotasks();

    const statsLogs = logs.filter((message) => message.includes("frame stats"));
    expect(statsLogs.length).toBeGreaterThanOrEqual(1);
    // chat 与 session 各计 1 帧、字节数为正
    const chatLog = statsLogs.find((message) => message.includes("prefix=chat"));
    const sessionLog = statsLogs.find((message) => message.includes("prefix=session"));
    expect(chatLog).toMatch(/frames=1 bytes=\d+/);
    expect(sessionLog).toMatch(/frames=1 bytes=\d+/);
    // 打点不得泄露会话内容
    expect(logs.join("\n")).not.toContain("secret-chat-content");
    expect(logs.join("\n")).not.toContain("secret-session-content");
    expect(logs.join("\n")).not.toContain("chat-payload-marker");
  });

  // 未注入 reportLog 时不采集打点（零开销），广播行为不受影响。
  test("skips metric collection when no reportLog is injected", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    addClient(registry, "ws-1", ws, "rcs-1");
    const doc = new Y.Doc();
    broadcaster.registerYjsDocListener(doc, "chat:rcs-1");

    doc.getMap("chat").set("message", "no metrics consumer");
    await flushMicrotasks();

    expect(decodeUpdateFrames(ws)).toHaveLength(1);
  });
});
