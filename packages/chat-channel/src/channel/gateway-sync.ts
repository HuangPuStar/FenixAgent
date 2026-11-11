import { SLOW_CONSUMER_RESYNC_TIMEOUT_REASON } from "../transport/ws-close-codes";
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
  delivering: Map<string, Promise<void>>;
  resolve: () => void;
  recover?: () => void;
}

export interface InitialDocSyncResult {
  readonly ok: boolean;
  readonly failedDocNames: readonly string[];
  readonly superseded?: boolean;
}

/** 当前代次的成对投影；只读获取，不能用旧快照恢复已经换代的会话。 */
interface InitialProjection {
  readonly chatDoc: ChatDoc;
  readonly sessionDoc: SessionDoc;
}

/** Chat 与 Session 必须仍共同属于本轮 generation，缺失任意投影也不构成证明。 */
function projectionMatches(getCurrent: (() => InitialProjection | null) | undefined, generation: string): boolean {
  if (!getCurrent) return true;
  const current = getCurrent();
  return current?.chatDoc.generation === generation && current.sessionDoc.generation === generation;
}

function recordDelivery(pending: PendingInitialSync, docName: string, delivery: LegacyFrameDelivery): void {
  if (delivery.completion) {
    if (pending.delivering.has(docName)) return;
    const task = delivery.completion.then((result) => {
      pending.delivering.delete(docName);
      recordDelivery(pending, docName, result);
      settlePending(pending);
      if (pending.received.size === pending.expected.size && pending.failed.size === 0) pending.recover?.();
    });
    pending.delivering.set(docName, task);
    return;
  }
  if (pending.delivering.has(docName)) return;
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

/** 初始同步被换代打断时最多重启两次；频繁换代交由有界重连重新绑定。 */
export async function synchronizeInitialDocs(
  pendingSyncs: Map<string, PendingInitialSync>,
  broadcaster: YjsBroadcaster,
  ws: WsConnection,
  wsId: string,
  rcsSessionId: string,
  chatDoc: ChatDoc,
  sessionDoc: SessionDoc,
  currentProjection?: () => InitialProjection | null,
): Promise<InitialDocSyncResult> {
  let projection = { chatDoc, sessionDoc };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await synchronizeInitialAttempt(
      pendingSyncs,
      broadcaster,
      ws,
      wsId,
      rcsSessionId,
      projection.chatDoc,
      projection.sessionDoc,
      currentProjection,
    );
    if (!result.superseded) return result;
    const next = currentProjection?.();
    if (!next || next.chatDoc.generation !== next.sessionDoc.generation) break;
    projection = next;
  }
  ws.close(1013, SLOW_CONSUMER_RESYNC_TIMEOUT_REASON);
  return { ok: false, failedDocNames: [] };
}

/** 单轮差量握手；分片有界等待后按当前成对投影生成交付证明。 */
async function synchronizeInitialAttempt(
  pendingSyncs: Map<string, PendingInitialSync>,
  broadcaster: YjsBroadcaster,
  ws: WsConnection,
  wsId: string,
  rcsSessionId: string,
  chatDoc: ChatDoc,
  sessionDoc: SessionDoc,
  currentProjection?: () => InitialProjection | null,
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
      delivering: new Map(),
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
      if (pending.received.has(docName) || pending.delivering.has(docName)) continue;
      const generation = doc.generation;
      recordDelivery(
        pending,
        docName,
        broadcaster.sendSnapshot(ws, doc.ydoc, docName, generation, (recovered) =>
          noteInitialSyncDelivery(pendingSyncs, wsId, docName, generation, recovered),
        ),
      );
    }
  }
  // 500ms 只限制 state-vector 握手；分片已经开始时等待其有界投递，不能另发全量快照。
  await Promise.all(pending.delivering.values());
  if (ws.readyState !== 1 || pendingSyncs.get(wsId) !== pending) return { ok: false, failedDocNames: docNames };
  if (!projectionMatches(currentProjection, pending.generation)) {
    pendingSyncs.delete(wsId);
    return { ok: false, failedDocNames: [], superseded: true };
  }
  const complete = () => {
    if (ws.readyState !== 1 || pendingSyncs.get(wsId) !== pending) return false;
    if (!projectionMatches(currentProjection, pending.generation)) {
      pendingSyncs.delete(wsId);
      ws.close(1013, SLOW_CONSUMER_RESYNC_TIMEOUT_REASON);
      return false;
    }
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
