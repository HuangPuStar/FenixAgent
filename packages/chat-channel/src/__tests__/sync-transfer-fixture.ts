import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { readDirectoryPage, readDirectoryRoot } from "../sync/protocol/directory";
import { decodeSyncFrame, encodeSyncFrame, type SyncFrame } from "../sync/protocol/frames";
import { createSyncHostSession, type SyncHostSession } from "../sync/runtime/host-session";
import { MemoryProjectionStore } from "../sync/store/memory-store";

const SCOPE = { organizationId: "组织".repeat(20), rcsSessionId: "会话".repeat(20) };
const CLOCK = { now: () => 1_700_000_000_000 };
const LIFECYCLE = { sealGraceMs: 2_000, retireGraceMs: 30_000 };

/** 只替换 socket 与时钟；存储、历史构建、实时入口、provider 与 ACK 均走生产实现。 */
export async function transferFixture() {
  const root = mkdtempSync(join(tmpdir(), "sync-transfer-"));
  const store = new MemoryProjectionStore({
    clock: CLOCK,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
  const hosts: SyncHostSession[] = [];
  async function connect() {
    const frames: SyncFrame[] = [];
    const closes: string[] = [];
    const socket = { buffered: 0, accepts: true };
    const host = await createSyncHostSession({
      scope: SCOPE,
      store,
      clock: CLOCK,
      digest: sha256Digest,
      random: deterministicRandomSource(`transfer-${hosts.length}`),
      runtimeConfig: { ...LIFECYCLE, tickIntervalMs: 600_000, spoolRootDir: root },
      transport: {
        send(bytes) {
          if (!socket.accepts) return false;
          frames.push(decodeSyncFrame(bytes));
          return true;
        },
        bufferedAmount: () => socket.buffered,
        close: (reason) => closes.push(reason),
      },
    });
    hosts.push(host);
    const send = async (frame: SyncFrame) => host.onInboundBytes(encodeSyncFrame(frame));
    async function hello() {
      await send({ type: "HELLO", protocolVersion: 1, scope: SCOPE, loadedDocs: [], stateful: false });
      const manifest = frames.find((frame) => frame.type === "MANIFEST");
      if (manifest?.type !== "MANIFEST") throw new Error("缺少 MANIFEST");
      return manifest;
    }
    const applied = new Map<string, Y.Doc>();
    let processed = 0;
    async function drain() {
      while (processed < frames.length) {
        const frame = frames[processed++];
        if (frame.type !== "DOC_BASE" && frame.type !== "DOC_UPDATE") continue;
        const payload = Buffer.from(frame.payload, "base64");
        expect(payload.byteLength).toBe(frame.encodedLength);
        expect(sha256Digest(payload)).toBe(frame.payloadDigest);
        let doc = applied.get(frame.docId);
        if (!doc) {
          doc = new Y.Doc();
          applied.set(frame.docId, doc);
        }
        Y.applyUpdate(doc, payload);
        await send({
          type: "APPLY_ACK",
          protocolVersion: 1,
          transportEpoch: frame.transportEpoch,
          deliveryId: frame.deliveryId,
          result: "processed",
          docId: frame.docId,
          appliedSeq: frame.type === "DOC_BASE" ? frame.baseSeq : frame.toSeq,
        });
      }
    }
    async function subscribe(docIds: readonly string[]) {
      await send({ type: "SUBSCRIBE", protocolVersion: 1, docIds: [...docIds], priority: "live" });
    }
    async function receive(docIds: readonly string[]) {
      await subscribe(docIds);
      for (let attempt = 0; attempt < 60; attempt++) {
        await drain();
        if (docIds.every((id) => applied.has(id))) return;
        await host.tick();
      }
      throw new Error(`缺少基线：${docIds.filter((id) => !applied.has(id)).length}`);
    }
    async function discover(directoryDocId: string) {
      await receive([directoryDocId]);
      let pageId = readDirectoryRoot(applied.get(directoryDocId)!).latestPageId;
      const ids: string[] = [];
      while (pageId) {
        await receive([pageId]);
        const page = readDirectoryPage(applied.get(pageId)!);
        ids.unshift(...page.contentDocIds);
        pageId = page.previousPageId;
      }
      return ids;
    }
    return { host, frames, closes, socket, send, hello, drain, subscribe, receive, discover, applied };
  }
  return {
    store,
    connect,
    async dispose() {
      for (const host of hosts) await host.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 按块目录顺序读取 live 记录；跨块 partIndex 是局部值，不能全局重排。 */
export function liveText(docs: readonly Y.Doc[]): string {
  return docs
    .flatMap((doc) => {
      const records = doc.getMap("root").get("records");
      if (!(records instanceof Y.Array)) return [];
      return records.toArray().map((record: { payload: Uint8Array }) => new TextDecoder().decode(record.payload));
    })
    .join("");
}

/** 等待真实入口队列落库，终态失败立即暴露而非等待超时掩盖。 */
export async function writeText(host: SyncHostSession, text: string, small = false) {
  const pieces = small ? (text.match(/.{1,4096}/gu) ?? []) : [text];
  for (const piece of pieces) {
    host.acceptNormalizedEvent({
      type: "message_delta",
      turnId: "turn-large",
      update: { content: { type: "text", text: piece } },
    });
    if (small) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  host.acceptNormalizedEvent({
    type: "message_delta",
    turnId: "turn-next",
    update: { content: { type: "text", text: "后续轮次" } },
  });
  // 合并窗口 + 分片提交在并行测试负载下需要留出落库时间；停写会立即由断言暴露。
  await new Promise((resolve) => setTimeout(resolve, 300));
  await host.tick();
  expect(host.ingressDiagnostics().stopped).toBe(false);
}
