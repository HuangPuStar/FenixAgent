// packages/chat-channel/src/channel/gateway-message.ts
// 单条入站消息的协议分派：new sync 帧、legacy state-vector 与 JSON action。
//
// 本模块只做分派，不捕获顶层异常；`Gateway.handleMessage` 负责把任何处理失败收敛到
// 「记录诊断 + 关闭受影响连接」，避免未处理的 Promise 拒绝进入进程事件循环。

import { decodeYjsSyncFrame } from "../protocol/update-frame";
import type { DocManager } from "../state";
import type { YjsBroadcaster } from "./broadcaster";
import type { ConnectionRegistry } from "./connection-registry";
import type { ChatSyncProtocolConfig, ClientConnection, WsConnection } from "./connection-types";
import type { PendingInitialSync } from "./gateway-sync";
import { type GatewaySyncHostOverrides, routeSyncProtocolFrame } from "./sync-connection";

export interface GatewayMessageHandlerDeps {
  readonly registry: ConnectionRegistry;
  readonly broadcaster: YjsBroadcaster;
  readonly docManager: DocManager;
  readonly chatSyncProtocol?: ChatSyncProtocolConfig;
  readonly syncHostOverrides?: GatewaySyncHostOverrides;
  readonly pendingInitialSync: Map<string, PendingInitialSync>;
  readonly reportError: (message: string, error: unknown) => void;
  readonly forward: (entry: ClientConnection, parsed: Record<string, unknown>, ws: WsConnection) => Promise<void>;
}

export type GatewayMessageHandler = (ws: WsConnection, wsId: string, data: string | Uint8Array) => Promise<void>;

/** 返回消息分派函数；调用方负责隔离异常（见 Gateway.handleMessage）。 */
export function createGatewayMessageHandler(deps: GatewayMessageHandlerDeps): GatewayMessageHandler {
  return async (ws, wsId, data) => {
    const entry = deps.registry.getClient(wsId);
    if (typeof data !== "string") {
      const routed = await routeSyncProtocolFrame(
        entry,
        ws,
        data,
        deps.chatSyncProtocol,
        (message, error) => deps.reportError(`[YJS-FE] ${message}`, error),
        deps.syncHostOverrides,
        { registry: deps.registry, wsId, docManager: deps.docManager },
      );
      if (routed) return;
      const frame = decodeYjsSyncFrame(data);
      if (!entry || frame?.type !== "state-vector") return;
      const prefix = frame.docName.split(":", 1)[0];
      const expectedName = `${prefix}:${entry.rcsSessionId}`;
      if (frame.docName !== expectedName) return;
      const doc =
        prefix === "chat"
          ? deps.docManager.getChat(entry.rcsSessionId)
          : deps.docManager.getSession(entry.rcsSessionId);
      if (!doc || doc.generation !== frame.generation) return;
      deps.broadcaster.sendDiff(ws, doc.ydoc, frame.docName, frame.generation, frame.stateVector);
      const pendingSync = deps.pendingInitialSync.get(wsId);
      if (pendingSync?.expected.has(frame.docName)) {
        pendingSync.received.add(frame.docName);
        if (pendingSync.received.size === pendingSync.expected.size) pendingSync.resolve();
      }
      return;
    }
    if (!entry?.relayReady) {
      deps.registry.bufferPending(wsId, data);
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed.type === "ping") {
      deps.broadcaster.sendToYjsWs(ws, { type: "pong" });
      return;
    }
    if (parsed.type === "keep_alive") return;
    if (parsed.action) await deps.forward(entry, parsed, ws);
  };
}
