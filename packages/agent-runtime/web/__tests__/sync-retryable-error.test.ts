// retryable ERROR 的有界重连：容量/准入等瞬态失败先重建 stateless 同步连接，
// 终态失败直接交回旧通道；重连耗尽后必须停在明确的 error 状态，不能无限退避。
import { describe, expect, test } from "bun:test";
import { encodeSyncFrame, SYNC_PROTOCOL_VERSION, type SyncFrame } from "@fenix/chat-channel/server";
import * as Y from "yjs";
import type { SyncChatProjection } from "../yjs/sync-doc-hub";
import type { SyncChatConnectionState, SyncChatSessionOptions } from "../yjs/sync-transport";
import {
  createSyncChatSession,
  MAX_RETRYABLE_ERROR_RECONNECTS,
  RETRYABLE_RECOVERY_STABLE_MS,
} from "../yjs/sync-transport";
import type { SyncBrowserSocket } from "../yjs/yjs-ws";

const GEN = "gen_retryable01";
const CONTENT_DOC = `sync/content/${GEN}/1/content_a`;
const URL_UNDER_TEST = "ws://test.local/acp/yjs/env_1?chatSync=1";

class RetrySocket implements SyncBrowserSocket {
  static instances: RetrySocket[] = [];

  binaryType = "arraybuffer";
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    RetrySocket.instances.push(this);
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
}

function errorFrame(retryable: boolean, code: "ADMISSION_REJECTED" | "PROTOCOL_VERSION_UNSUPPORTED"): SyncFrame {
  return {
    type: "ERROR",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    code,
    retryable,
    message: retryable ? "temporary capacity exhausted" : "unsupported version",
  };
}

function manifest(): SyncFrame {
  return {
    type: "MANIFEST",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    generation: GEN,
    pointerRevision: 1,
    referenceRevision: 1,
    controlDocId: `sync/control/${GEN}/0/control`,
    runtimeDocId: `sync/runtime/${GEN}/0/runtime`,
    directoryDocId: `sync/directory/${GEN}/0/root`,
    recoveryState: "ready",
  };
}

function contentUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const root = doc.getMap<unknown>("root");
    root.set("schemaVersion", 1);
    root.set("kind", "content");
    root.set("generation", GEN);
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

function docBase(docId: string, text: string, deliveryId: string): Extract<SyncFrame, { type: "DOC_BASE" }> {
  const payload = contentUpdate(text);
  return {
    type: "DOC_BASE",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    docId,
    generation: GEN,
    transportEpoch: "tx_1",
    subscriptionEpoch: "sub_1",
    syncAttemptId: "att_1",
    deliveryId,
    baseSeq: 0,
    mode: "full",
    payloadDigest: "sha256:test",
    encodedLength: payload.byteLength,
    payload: Buffer.from(payload).toString("base64"),
  };
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

const ENTRY_DOC_IDS = [
  `sync/control/${GEN}/0/control`,
  `sync/runtime/${GEN}/0/runtime`,
  `sync/directory/${GEN}/0/root`,
];
/** 首批基线包含入口 Doc 与调试后备内容块（applyDirectory 会把它加回等待集合）。 */
const BASELINE_DOC_IDS = [...ENTRY_DOC_IDS, CONTENT_DOC];

/** 完成一次真实基线：MANIFEST + 首批 DOC_BASE + drain 产生的 processed ACK。 */
async function applyBaseline(
  harness: ReturnType<typeof createHarness>,
  socket: RetrySocket,
  cycle: number,
): Promise<void> {
  socket.receive(manifest());
  BASELINE_DOC_IDS.forEach((docId, index) => {
    socket.receive(docBase(docId, `base-${cycle}`, `dlv_${cycle}_${index}`));
  });
  await flush();
  expect(harness.states.at(-1)?.baselineApplied).toBe(true);
}

function createHarness(overrides: Partial<SyncChatSessionOptions> = {}) {
  RetrySocket.instances = [];
  const states: SyncChatConnectionState[] = [];
  const projections: SyncChatProjection[] = [];
  const scheduled: Array<() => void> = [];
  const delays: number[] = [];
  let nowMs = 0;
  const session = createSyncChatSession({
    agentId: "env_1",
    instanceUid: "inst_1",
    rcsSessionId: "rcs_1",
    organizationId: "org_1",
    contentDocIds: [CONTENT_DOC],
    url: URL_UNDER_TEST,
    socketFactory: (url) => new RetrySocket(url),
    now: () => nowMs,
    yieldToHost: async () => {},
    autoReconnect: true,
    schedule: (task, delayMs) => {
      scheduled.push(task);
      delays.push(delayMs);
      return () => {};
    },
    onState: (state) => states.push(state),
    onProjection: (projection) => projections.push(projection),
    ...overrides,
  });
  session.connect();
  const socket = (): RetrySocket => {
    const current = RetrySocket.instances.at(-1);
    if (current === undefined) throw new Error("fake socket was not created");
    return current;
  };
  return {
    session,
    states,
    projections,
    scheduled,
    delays,
    socket,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("同步会话可重试 ERROR", () => {
  // 瞬态拒绝必须走 stateless 重连，并在新连接应用基线后恢复投影，而不是永久降级。
  test("可重试 ERROR 退避重连，新连接基线落地后恢复投影", async () => {
    const harness = createHarness();
    try {
      const first = harness.socket();
      first.open();
      first.receive(errorFrame(true, "ADMISSION_REJECTED"));
      expect(harness.states.at(-1)).toMatchObject({
        status: "reconnecting",
        error: { code: "ADMISSION_REJECTED", retryable: true, source: "error-frame" },
      });
      expect(harness.scheduled).toHaveLength(1);
      expect(harness.delays).toEqual([1000]);
      harness.scheduled.shift()?.();

      const second = harness.socket();
      expect(second).not.toBe(first);
      second.open();
      second.receive(manifest());
      second.receive(docBase(CONTENT_DOC, "recovered", "dlv_recovered"));
      await flush();
      expect(harness.states.at(-1)?.status).toBe("ready");
      expect(visibleText(harness.projections.at(-1))).toBe("recovered");
    } finally {
      harness.session.dispose();
    }
  });

  // 终态 ERROR 不安排任何重试：协议不支持时重连只会得到同样的拒绝。
  test("终态 ERROR 直接失败且不安排重连", () => {
    const harness = createHarness();
    try {
      const first = harness.socket();
      first.open();
      first.receive(errorFrame(false, "PROTOCOL_VERSION_UNSUPPORTED"));
      expect(harness.states.at(-1)).toMatchObject({
        status: "error",
        error: { code: "PROTOCOL_VERSION_UNSUPPORTED", retryable: false, source: "error-frame" },
      });
      expect(harness.scheduled).toHaveLength(0);
      expect(RetrySocket.instances).toHaveLength(1);
    } finally {
      harness.session.dispose();
    }
  });

  // 连续可重试失败必须有上限：耗尽后停在 error（由上层降级），不能无限占用退避重连。
  test("可重试 ERROR 连续耗尽后进入明确失败状态", () => {
    const harness = createHarness();
    try {
      let current = harness.socket();
      current.open();
      for (let attempt = 0; attempt < MAX_RETRYABLE_ERROR_RECONNECTS; attempt += 1) {
        current.receive(errorFrame(true, "ADMISSION_REJECTED"));
        expect(harness.states.at(-1)?.status).toBe("reconnecting");
        harness.scheduled.shift()?.();
        current = harness.socket();
        current.open();
      }
      expect(harness.delays).toEqual([1000, 2000, 4000]);
      current.receive(errorFrame(true, "ADMISSION_REJECTED"));
      expect(harness.states.at(-1)).toMatchObject({
        status: "error",
        error: { code: "ADMISSION_REJECTED", retryable: true, source: "error-frame" },
      });
      expect(harness.scheduled).toHaveLength(0);
      expect(RetrySocket.instances).toHaveLength(MAX_RETRYABLE_ERROR_RECONNECTS + 1);
    } finally {
      harness.session.dispose();
    }
  });

  // MANIFEST 与基线成功都不能清零额度：服务端在握手后持续拒绝时必须停在有界终点。
  test("MANIFEST 成功后持续 retryable ERROR 仍在累计额度内终止", async () => {
    const harness = createHarness();
    try {
      let current = harness.socket();
      current.open();
      for (let attempt = 0; attempt <= MAX_RETRYABLE_ERROR_RECONNECTS; attempt += 1) {
        if (attempt > 0) {
          current = harness.socket();
          current.open();
        }
        await applyBaseline(harness, current, attempt);
        current.receive(errorFrame(true, "ADMISSION_REJECTED"));
        if (attempt < MAX_RETRYABLE_ERROR_RECONNECTS) {
          expect(harness.states.at(-1)?.status).toBe("reconnecting");
          harness.scheduled.shift()?.();
        }
      }
      expect(harness.states.at(-1)).toMatchObject({
        status: "error",
        error: { code: "ADMISSION_REJECTED", retryable: true, source: "error-frame" },
      });
      expect(harness.scheduled).toHaveLength(0);
      expect(RetrySocket.instances).toHaveLength(MAX_RETRYABLE_ERROR_RECONNECTS + 1);
    } finally {
      harness.session.dispose();
    }
  });

  // 基线应用后稳定满窗口才恢复额度：健康连接不应因为一次瞬态错误直接进入终态。
  test("基线应用后稳定满窗口再恢复重试额度", async () => {
    const harness = createHarness();
    try {
      let current = harness.socket();
      current.open();
      for (let attempt = 0; attempt < MAX_RETRYABLE_ERROR_RECONNECTS - 1; attempt += 1) {
        await applyBaseline(harness, current, attempt);
        current.receive(errorFrame(true, "ADMISSION_REJECTED"));
        expect(harness.states.at(-1)?.status).toBe("reconnecting");
        harness.scheduled.shift()?.();
        current = harness.socket();
        current.open();
      }
      await applyBaseline(harness, current, MAX_RETRYABLE_ERROR_RECONNECTS - 1);
      harness.advance(RETRYABLE_RECOVERY_STABLE_MS);
      current.receive(errorFrame(true, "ADMISSION_REJECTED"));
      // 稳定窗口已满：本次错误重新从第一次退避开始，而不是带着旧额度进入终态。
      expect(harness.states.at(-1)?.status).toBe("reconnecting");
      expect(harness.scheduled).toHaveLength(1);
      expect(harness.delays.at(-1)).toBe(1000);
    } finally {
      harness.session.dispose();
    }
  });

  // 基线超时只结束展示层 hydrating，不能当作“已应用”：发送门禁的恢复条件仍然不成立。
  test("基线超时不算基线已应用", async () => {
    const harness = createHarness({ syncBaseTimeoutMs: 1 });
    try {
      const current = harness.socket();
      current.open();
      current.receive(manifest());
      expect(harness.states.at(-1)).toMatchObject({ status: "ready", hydrating: true, baselineApplied: false });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(harness.states.at(-1)).toMatchObject({ status: "ready", hydrating: false, baselineApplied: false });
    } finally {
      harness.session.dispose();
    }
  });
});
