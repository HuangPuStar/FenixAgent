// packages/agent-runtime/web/yjs/sync-content-tap.ts
// content Doc 帧旁路：把 DOC_BASE / DOC_UPDATE 镜像到只读投影，并驱动基线完成判定。
//
// 与 `sync-transport.ts` 分离的原因：这段逻辑只依赖「已保留 Doc 集合 + 代次 + 投影入口」，
// 不参与握手/重连/ACK；独立后 transport 保持可读，且该路径可单独测试。
// 校验只做展示层需要的最小集合：协议版本、docId/generation 归属、deliveryId 去重与
// encodedLength 一致性；真正的 schema/序号校验仍由 sync-client 的 transport 完成。

import { SYNC_PROTOCOL_VERSION } from "./sync-chat-state";
import { parseContentDocId } from "./sync-doc-hub";
import type { SyncHydrationTracker } from "./sync-hydration-tracker";
import { decodeSyncBase64Payload, decodeSyncWireJson } from "./yjs-ws";

/** deliveryId 去重窗口：足够覆盖重连前在途帧，超界丢弃最旧项。 */
const SEEN_DELIVERY_LIMIT = 4096;

export interface SyncContentTapDependencies {
  readonly retainedDocs: ReadonlySet<string>;
  readonly seenDeliveries: Set<string>;
  readonly expectedGeneration: () => string | null;
  readonly applyProjection: (input: {
    readonly docId: string;
    readonly generation: string;
    readonly payload: Uint8Array;
  }) => boolean;
  readonly hydration: Pick<SyncHydrationTracker, "noteBase">;
  /** 任意已保留 Doc 的基线到达；用于结束“加载更早”的等待状态。 */
  readonly onBase?: (docId: string) => void;
}

/** 出站 processed APPLY_ACK 是基线完成的确定性事实；发送失败时由调用方等待重试/超时。 */
export function noteProcessedAck(bytes: Uint8Array, hydration: Pick<SyncHydrationTracker, "noteAck">): void {
  const frame = decodeSyncWireJson(bytes);
  if (frame?.type === "APPLY_ACK" && frame.result === "processed" && typeof frame.deliveryId === "string") {
    hydration.noteAck(frame.deliveryId);
  }
}

/** 返回帧旁路入口；非 content 帧、异代次、重复 delivery 均静默忽略。 */
export function createSyncContentTap(deps: SyncContentTapDependencies): (frame: Record<string, unknown>) => void {
  return (frame) => {
    const type = frame.type;
    if (type !== "DOC_BASE" && type !== "DOC_UPDATE") return;
    if (frame.protocolVersion !== SYNC_PROTOCOL_VERSION) return;
    if (typeof frame.docId !== "string" || typeof frame.generation !== "string" || typeof frame.payload !== "string") {
      return;
    }
    if (!deps.retainedDocs.has(frame.docId)) return;
    const expectedGeneration = deps.expectedGeneration();
    if (expectedGeneration !== null && frame.generation !== expectedGeneration) return;
    const deliveryId = typeof frame.deliveryId === "string" ? frame.deliveryId : null;
    if (type === "DOC_BASE") {
      deps.hydration.noteBase(frame.docId, deliveryId);
      deps.onBase?.(frame.docId);
    }
    if (parseContentDocId(frame.docId) === null) return;

    if (deliveryId !== null) {
      if (deps.seenDeliveries.has(deliveryId)) return;
      deps.seenDeliveries.add(deliveryId);
      if (deps.seenDeliveries.size > SEEN_DELIVERY_LIMIT) {
        const oldest = deps.seenDeliveries.values().next();
        if (!oldest.done) deps.seenDeliveries.delete(oldest.value);
      }
    }
    const payload = decodeSyncBase64Payload(frame.payload);
    if (payload === null) return;
    if (typeof frame.encodedLength === "number" && frame.encodedLength !== payload.byteLength) return;
    deps.applyProjection({ docId: frame.docId, generation: frame.generation, payload });
  };
}
