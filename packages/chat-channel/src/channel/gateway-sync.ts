import type { ChatDoc, SessionDoc, YjsHistoryIncomplete } from "../types";
import type { LegacyFrameDelivery, YjsBroadcaster } from "./broadcaster";
import type { WsConnection } from "./connection-types";

const YJS_SYNC_TIMEOUT_MS = 500;

export interface PendingInitialSync {
  expected: Set<string>;
  received: Set<string>;
  /** 服务端明确无法交付的文档；与 received 一起收敛等待，但不等于同步成功。 */
  failed: Map<string, LegacyFrameDelivery>;
  resolve: () => void;
}

export interface InitialDocSyncResult {
  readonly ok: boolean;
  readonly failedDocNames: readonly string[];
}

function rememberFailure(
  pending: PendingInitialSync | undefined,
  docName: string,
  delivery: LegacyFrameDelivery,
): void {
  if (delivery.ok || pending === undefined) return;
  pending.failed.set(docName, delivery);
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
  delivery: LegacyFrameDelivery,
): void {
  const pending = pendingSyncs.get(wsId);
  if (pending === undefined || !pending.expected.has(docName)) return;
  if (delivery.ok) pending.received.add(docName);
  else pending.failed.set(docName, delivery);
  settlePending(pending);
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
  let pending: PendingInitialSync | undefined;
  let syncTimedOut = false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      syncTimedOut = true;
      pendingSyncs.delete(wsId);
      resolve();
    }, YJS_SYNC_TIMEOUT_MS);
    pending = {
      expected: new Set(docNames),
      received: new Set(),
      failed: new Map(),
      resolve: () => {
        clearTimeout(timer);
        pendingSyncs.delete(wsId);
        resolve();
      },
    };
    pendingSyncs.set(wsId, pending);
    broadcaster.sendToYjsWs(ws, {
      type: "yjs:sync-request",
      docs: docNames.map((docName) => ({ docName, generation: chatDoc.generation })),
    });
  });
  if (syncTimedOut) {
    const chatDelivery = broadcaster.sendSnapshot(ws, chatDoc.ydoc, docNames[0], chatDoc.generation);
    const sessionDelivery = broadcaster.sendSnapshot(ws, sessionDoc.ydoc, docNames[1], sessionDoc.generation);
    rememberFailure(pending, docNames[0], chatDelivery);
    rememberFailure(pending, docNames[1], sessionDelivery);
  }
  const failed = pending?.failed ?? new Map<string, LegacyFrameDelivery>();
  if (failed.size === 0) return { ok: true, failedDocNames: [] };
  // 数据未交付不是“已同步”：把缺失文档与超限尺寸显式交给客户端，由其展示恢复入口。
  broadcaster.sendToYjsWs(ws, {
    type: "yjs:history-incomplete",
    ...incompletePayload(failed, chatDoc.generation),
  });
  return { ok: false, failedDocNames: [...failed.keys()] };
}
