// 1012 是服务端「投影已换代」的非终态关闭：客户端必须重连并只接受新代次帧。

import { describe, expect, test } from "bun:test";
import { decodeSyncFrame, encodeSyncFrame, SYNC_PROTOCOL_VERSION, type SyncFrame } from "@fenix/chat-channel/server";
import * as Y from "yjs";
import type { SyncChatProjection } from "../yjs/sync-doc-hub";
import type { SyncChatConnectionState, SyncChatSessionOptions } from "../yjs/sync-transport";
import { createSyncChatSession } from "../yjs/sync-transport";
import type { SyncBrowserSocket } from "../yjs/yjs-ws";

const GEN_ONE = "gen_one00000001";
const GEN_TWO = "gen_two00000002";
const URL_UNDER_TEST = "ws://test.local/acp/yjs/env_1?chatSync=1";

function contentDocId(generation: string, nonce: string): string {
  return `sync/content/${generation}/1/${nonce}`;
}

class FakeSocket implements SyncBrowserSocket {
  static instances: FakeSocket[] = [];

  binaryType = "arraybuffer";
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(frame: SyncFrame): void {
    this.onmessage?.(encodeSyncFrame(frame));
  }

  closeFromServer(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.(code, reason);
  }
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function contentUpdate(generation: string, text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const root = doc.getMap<unknown>("root");
    root.set("schemaVersion", 1);
    root.set("kind", "content");
    root.set("generation", generation);
    root.set("blockIndex", 1);
    const records = new Y.Array<Record<string, unknown>>();
    root.set("records", records);
    records.push([
      {
        recordId: `rec_${text}`,
        entryId: `turn_${text}:assistant`,
        entryOrder: 1,
        contentSlot: "text",
        partIndex: 0,
        kind: "text",
        payload: new TextEncoder().encode(text),
      },
    ]);
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function manifest(generation: string, revision: number): SyncFrame {
  return {
    type: "MANIFEST",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    generation,
    pointerRevision: revision,
    referenceRevision: revision,
    controlDocId: `sync/control/${generation}/0/control`,
    runtimeDocId: `sync/runtime/${generation}/0/runtime`,
    directoryDocId: `sync/directory/${generation}/0/root`,
    recoveryState: "ready",
  };
}

function docBase(
  docId: string,
  generation: string,
  text: string,
  deliveryId: string,
): Extract<SyncFrame, { type: "DOC_BASE" }> {
  const payload = contentUpdate(generation, text);
  return {
    type: "DOC_BASE",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    docId,
    generation,
    transportEpoch: "tx_1",
    subscriptionEpoch: "sub_1",
    syncAttemptId: "att_1",
    deliveryId,
    baseSeq: 0,
    mode: "full",
    payloadDigest: "sha256:test",
    encodedLength: payload.byteLength,
    payload: base64(payload),
  };
}

function sentFrames(socket: FakeSocket): SyncFrame[] {
  return socket.sent.map((bytes) => decodeSyncFrame(bytes));
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function visibleText(projection: SyncChatProjection | undefined): string {
  return (projection?.messages ?? [])
    .map((message) =>
      message.type === "assistant_message"
        ? message.chunks.map((chunk) => (chunk.type === "message" ? chunk.text : "")).join("")
        : "",
    )
    .join("");
}

function createHarness(overrides: Partial<SyncChatSessionOptions> = {}) {
  FakeSocket.instances = [];
  const states: SyncChatConnectionState[] = [];
  const projections: SyncChatProjection[] = [];
  const scheduled: Array<() => void> = [];
  const session = createSyncChatSession({
    agentId: "env_1",
    instanceUid: "inst_1",
    rcsSessionId: "rcs_1",
    organizationId: "org_1",
    contentDocIds: [contentDocId(GEN_ONE, "content_a"), contentDocId(GEN_TWO, "content_b")],
    url: URL_UNDER_TEST,
    socketFactory: (url) => new FakeSocket(url),
    yieldToHost: async () => {},
    autoReconnect: true,
    schedule: (task) => {
      scheduled.push(task);
      return () => {};
    },
    onState: (state) => states.push(state),
    onProjection: (projection) => projections.push(projection),
    ...overrides,
  });
  session.connect();
  const first = FakeSocket.instances[0];
  if (first === undefined) throw new Error("fake socket was not created");
  return { session, first, states, projections, scheduled };
}

describe("同步会话 1012 换代重连", () => {
  // 服务端以 1012 宣告投影替换时按非终态重连，并丢弃旧代次帧、绑定新 MANIFEST 代次。
  test("1012 重连后只应用新代次内容", async () => {
    const harness = createHarness();
    harness.first.open();
    harness.first.receive(manifest(GEN_ONE, 1));
    harness.first.receive(docBase(contentDocId(GEN_ONE, "content_a"), GEN_ONE, "one", "dlv_one"));
    await flush();
    expect(visibleText(harness.projections.at(-1))).toBe("one");

    harness.first.closeFromServer(1012, "projection replaced");
    expect(harness.states.at(-1)?.status).toBe("reconnecting");
    expect(harness.scheduled).toHaveLength(1);

    harness.scheduled[0]?.();
    const second = FakeSocket.instances[1];
    expect(second).toBeDefined();
    if (second === undefined) throw new Error("reconnect socket was not created");
    second.open();
    const hello = sentFrames(second).find((frame) => frame.type === "HELLO");
    expect(hello).toBeDefined();
    expect(hello && "generation" in hello).toBe(false);

    // 旧 socket 关闭后的迟到帧与新 socket 上的旧代次帧都不得进入新投影。
    harness.first.receive(docBase(contentDocId(GEN_ONE, "content_a"), GEN_ONE, "stale-old-socket", "dlv_stale_a"));
    second.receive(manifest(GEN_TWO, 2));
    second.receive(docBase(contentDocId(GEN_TWO, "content_b"), GEN_ONE, "stale-generation", "dlv_stale_b"));
    await flush();
    expect(harness.states.at(-1)?.generation).toBe(GEN_TWO);
    expect(visibleText(harness.projections.at(-1))).toBe("");

    second.receive(docBase(contentDocId(GEN_TWO, "content_b"), GEN_TWO, "two", "dlv_two"));
    await flush();
    expect(visibleText(harness.projections.at(-1))).toBe("two");

    harness.session.dispose();
  });
});
