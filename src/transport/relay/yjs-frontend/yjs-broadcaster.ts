import * as Y from "yjs";
import type { WsConnection } from "../../ws-types";
import type { ConnectionRegistry } from "./connection-registry";

const WS_SEND_THRESHOLD = 64 * 1024;

/** 负责 Y.Doc 更新的批处理、路由与 WebSocket 发送。 */
export class YjsBroadcaster {
  private readonly registeredDocs = new Map<string, { ydoc: Y.Doc; listener: (update: Uint8Array) => void }>();
  private updateBuffers = new Map<string, Uint8Array[]>();
  private pendingDocNames = new Set<string>();
  private flushScheduled = false;

  constructor(private readonly registry: ConnectionRegistry) {}

  sendToYjsWs(ws: WsConnection, data: unknown): void {
    if (ws.readyState !== 1) return;
    // biome-ignore lint/suspicious/noExplicitAny: bufferedAmount 不在 WsConnection 接口中，但 Bun WS 原生支持
    if (((ws as any).bufferedAmount ?? 0) > WS_SEND_THRESHOLD) return;
    ws.send(JSON.stringify(data));
  }

  sendSnapshot(ws: WsConnection, ydoc: Y.Doc, docName: string): void {
    this.sendToYjsWs(ws, this.createUpdateMessage(ydoc, docName));
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
    this.broadcastMessage(docName, {
      type: "yjs:update",
      docName,
      data: Buffer.from(update).toString("base64"),
    });
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
