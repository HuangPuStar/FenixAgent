import type { ChatDoc, SessionDoc, YjsHistoryIncomplete } from "../types";
import type { LegacyFrameDelivery, YjsBroadcaster } from "./broadcaster";
import type { WsConnection } from "./connection-types";

const YJS_SYNC_TIMEOUT_MS = 500;

export interface PendingInitialSync {
  readonly generation: string;
  expected: Set<string>;
  received: Set<string>;
  /** 服务端明确无法交付的文档；与 received 一起收敛等待，但不等于同步成功。 */
  failed: Map<string, LegacyFrameDelivery>;
  resolve: () => void;
  recover?: () => void;
}

export interface InitialDocSyncResult {
  readonly ok: boolean;
  readonly failedDocNames: readonly string[];
}

function recordDelivery(pending: PendingInitialSync, docName: string, delivery: LegacyFrameDelivery): void {
  if (delivery.ok) {
    pending.received.add(docName);
    pending.failed.delete(docName);
  } else {
    pending.received.delete(docName);
    pending.failed.set(docName, delivery);
  }
}

function settlePending(pending: PendingInitialSync | undefined): void {
  if (pending === undefined) return;
  if (pending.received.size + pending.failed.size < pending.expected.size) return;
  pending.resolve();
}

/** 等待中的 state-vector 握手：差量已尝试但未送达时登记失败并立即收敛等待。 */
export function noteInitialSyncDelivery(
  pendingSyncs: Map<string, PendingInitialSync>,
  wsId: string,
  docName: string,
  generation: string,
  delivery: LegacyFrameDelivery,
): void {
  const pending = pendingSyncs.get(wsId);
  if (pending === undefined || pending.generation !== generation || !pending.expected.has(docName)) return;
  recordDelivery(pending, docName, delivery);
  settlePending(pending);
  if (pending.received.size === pending.expected.size && pending.failed.size === 0) pending.recover?.();
}

function incompletePayload(failed: ReadonlyMap<string, LegacyFrameDelivery>, generation: string): YjsHistoryIncomplete {
  const first = [...failed.values()][0];
  return {
    docs: [...failed.keys()],
    reason: first?.reason ?? "too_large",
    bytes: first?.bytes ?? 0,
    limitBytes: first?.limitBytes ?? 0,
    generation,
  };
}

export async function synchronizeInitialDocs(
  pendingSyncs: Map<string, PendingInitialSync>,
  broadcaster: YjsBroadcaster,
  ws: WsConnection,
  wsId: string,
  rcsSessionId: string,
  chatDoc: ChatDoc,
  sessionDoc: SessionDoc,
): Promise<InitialDocSyncResult> {
  const docNames = [`chat:${rcsSessionId}`, `session:${rcsSessionId}`];
  let pending!: PendingInitialSync;
  let syncTimedOut = false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      syncTimedOut = true;
      pending.resolve();
    }, YJS_SYNC_TIMEOUT_MS);
    pending = {
      generation: chatDoc.generation,
      expected: new Set(docNames),
      received: new Set(),
      failed: new Map(),
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
    };
    pendingSyncs.set(wsId, pending);
    broadcaster.sendToYjsWs(ws, {
      type: "yjs:sync-request",
      docs: docNames.map((docName) => ({ docName, generation: chatDoc.generation })),
    });
  });
  if (ws.readyState !== 1 || pendingSyncs.get(wsId) !== pending) return { ok: false, failedDocNames: docNames };
  if (syncTimedOut) {
    for (const [index, doc] of [chatDoc, sessionDoc].entries()) {
      const docName = docNames[index];
      if (pending.received.has(docName)) continue;
      recordDelivery(pending, docName, broadcaster.sendSnapshot(ws, doc.ydoc, docName, doc.generation));
    }
  }
  const complete = () => {
    if (ws.readyState !== 1 || pendingSyncs.get(wsId) !== pending) return false;
    // 显式成功标记：普通 update 夹杂实时广播，客户端不能据此判断缺失历史已恢复。
    const sent = broadcaster.sendToYjsWs(
      ws,
      {
        type: "yjs:sync-complete",
        docs: docNames,
        generation: chatDoc.generation,
      },
      true,
    );
    if (sent) pendingSyncs.delete(wsId);
    else ws.close(1013, "initial sync status delivery failed");
    return sent;
  };
  const failed = pending.failed;
  if (failed.size === 0) {
    pending.recover = complete;
    return { ok: complete(), failedDocNames: [] };
  }
  // 失败记录只随连接释放；同代迟到差量可补齐本轮证明，普通实时 update 不能解除门禁。
  pending.recover = complete;
  // 数据未交付不是“已同步”：把缺失文档与超限尺寸显式交给客户端，由其展示恢复入口。
  const notified = broadcaster.sendToYjsWs(
    ws,
    {
      type: "yjs:history-incomplete",
      ...incompletePayload(failed, chatDoc.generation),
    },
    true,
  );
  if (!notified) ws.close(1013, "initial sync status delivery failed");
  return { ok: false, failedDocNames: [...failed.keys()] };
}
