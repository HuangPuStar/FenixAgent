// packages/chat-channel/src/channel/broadcaster.ts
// YjsBroadcaster：Y.Doc 更新的批处理、按 rcsSessionId 隔离的路由与 WebSocket 发送。
//
// 迁移自 src/transport/relay/yjs-frontend/yjs-broadcaster.ts，语义原样保留：
// - 同 tick 内同一 Doc 的多次更新合并为一帧（Y.mergeUpdates），chat/session 保持独立帧；
// - 广播只发给同一 rcsSessionId 的客户端（禁止全局广播会话数据，CLAUDE.md YJS 不变量 5）；
// - 慢消费者背压：客户端 bufferedAmount 超过 64 KB 时跳过发送（等待重连后 snapshot 同步）。

import * as Y from "yjs";
import type { ConnectionRegistry } from "./connection-registry";
import type { WsConnection } from "./connection-types";

const WS_SEND_THRESHOLD = 64 * 1024;

/** 负责 Y.Doc 更新的批处理、路由与 WebSocket 发送。 */
export class YjsBroadcaster {
  private readonly registeredDocs = new Map<string, { ydoc: Y.Doc; listener: (update: Uint8Array) => void }>();
  private updateBuffers = new Map<string, Uint8Array[]>();
  private pendingDocNames = new Set<string>();
  private flushScheduled = false;

  constructor(private readonly registry: ConnectionRegistry) {}

  /** 发送单条消息到指定连接；缓冲超过 64 KB 的慢消费者跳过本次发送 */
  sendToYjsWs(ws: WsConnection, data: unknown): void {
    if (ws.readyState !== 1) return;
    // bufferedAmount 不在最小 WsConnection 接口中，但 Bun/浏览器 WS 原生支持；
    // 用最小类型收窄访问，避免 as any
    const bufferedAmount = (ws as WsConnection & { bufferedAmount?: number }).bufferedAmount ?? 0;
    if (bufferedAmount > WS_SEND_THRESHOLD) return;
    ws.send(JSON.stringify(data));
  }

  sendSnapshot(ws: WsConnection, ydoc: Y.Doc, docName: string): void {
    const msg = this.createUpdateMessage(ydoc, docName);
    this.sendToYjsWs(ws, msg);
  }

  broadcastSnapshot(ydoc: Y.Doc, docName: string): void {
    this.broadcastMessage(docName, this.createUpdateMessage(ydoc, docName));
  }

  unregisterYjsDocListener(docName: string): void {
    const registeredDoc = this.registeredDocs.get(docName);
    if (registeredDoc) {
      registeredDoc.ydoc.off("update", registeredDoc.listener);
    }
    this.registeredDocs.delete(docName);
    this.updateBuffers.delete(docName);
    this.pendingDocNames.delete(docName);
  }

  registerYjsDocListener(ydoc: Y.Doc, docName: string): void {
    if (this.registeredDocs.has(docName)) return;
    const listener = (update: Uint8Array) => {
      let buffers = this.updateBuffers.get(docName);
      if (!buffers) {
        buffers = [];
        this.updateBuffers.set(docName, buffers);
      }
      buffers.push(update);
      this.pendingDocNames.add(docName);
      this.scheduleFlush();
    };
    this.registeredDocs.set(docName, { ydoc, listener });
    ydoc.on("update", listener);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flushBroadcastsNow());
  }

  private flushBroadcastsNow(): void {
    this.flushScheduled = false;
    const updateBuffers = this.updateBuffers;
    const pendingDocNames = this.pendingDocNames;
    this.updateBuffers = new Map();
    this.pendingDocNames = new Set();

    for (const docName of pendingDocNames) {
      if (!this.registeredDocs.has(docName)) continue;
      const buffers = updateBuffers.get(docName);
      if (!buffers || buffers.length === 0) continue;
      const update = buffers.length === 1 ? buffers[0] : Y.mergeUpdates(buffers);
      this.broadcastUpdate(docName, update);
    }

    if (this.pendingDocNames.size > 0) {
      this.scheduleFlush();
    }
  }

  private broadcastUpdate(docName: string, update: Uint8Array): void {
    const message = {
      type: "yjs:update" as const,
      docName,
      data: Buffer.from(update).toString("base64"),
    };
    this.broadcastMessage(docName, message);
  }

  private createUpdateMessage(ydoc: Y.Doc, docName: string) {
    const snapshot = Y.encodeStateAsUpdate(ydoc);
    return {
      type: "yjs:update",
      docName,
      data: Buffer.from(snapshot).toString("base64"),
    };
  }

  private broadcastMessage(docName: string, message: unknown): void {
    const rcsSessionId = this.getRcsSessionId(docName);

    const send = (ws: WsConnection) => {
      try {
        this.sendToYjsWs(ws, message);
      } catch {
        // 单连接失败不阻塞
      }
    };

    if (rcsSessionId) {
      this.registry.forEachByRcsSession(rcsSessionId, (entry) => send(entry.ws));
      return;
    }
    this.registry.forEachClient((entry) => send(entry.ws));
  }

  private getRcsSessionId(docName: string): string | null {
    if (docName.startsWith("chat:")) return docName.slice(5);
    if (docName.startsWith("session:")) return docName.slice(8);
    return null;
  }
}
