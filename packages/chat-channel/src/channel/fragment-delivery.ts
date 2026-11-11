import {
  encodeYjsFragmentFrame,
  encodeYjsReplaceFrame,
  encodeYjsUpdateFrame,
  MAX_YJS_SYNC_PAYLOAD_BYTES,
  MAX_YJS_TRANSFER_BYTES,
  YJS_FRAGMENT_DATA_BYTES,
} from "../protocol/update-frame";
import { YJS_TRANSFER_TIMEOUT_MS } from "../transport/update-fragments";
import { SLOW_CONSUMER_RESYNC_TIMEOUT_REASON } from "../transport/ws-close-codes";
import type { WsConnection } from "./connection-types";

/** 分片的最终投递结果；排入发送任务不代表已交付。 */
export type FragmentDeliveryResult = "delivered" | "backpressure" | "encode_failed";

/** legacy 载荷未交付的原因。 */
export type LegacyFrameRejection = "too_large" | "backpressure" | "encode_failed";

/** 分片在途时 ok=false、reason=null，必须等待 completion 的最终投递结果。 */
export interface LegacyFrameDelivery {
  readonly ok: boolean;
  readonly bytes: number;
  readonly limitBytes: number;
  readonly reason: LegacyFrameRejection | null;
  readonly completion?: Promise<LegacyFrameDelivery>;
}

/** 已交接 socket 的最终结果。 */
export function deliveredLegacyFrame(bytes: number): LegacyFrameDelivery {
  return { ok: true, bytes, limitBytes: MAX_YJS_SYNC_PAYLOAD_BYTES, reason: null };
}

/** 可诊断的投递失败；不能用于同步完成证明。 */
export function rejectedLegacyFrame(bytes: number, reason: LegacyFrameRejection): LegacyFrameDelivery {
  return { ok: false, bytes, limitBytes: MAX_YJS_SYNC_PAYLOAD_BYTES, reason };
}

interface Transfer {
  bytes: number;
  completion: Promise<FragmentDeliveryResult>;
  finish: (result: FragmentDeliveryResult) => void;
}

interface SyncWaiter {
  bytes: number;
  completion: Promise<LegacyFrameDelivery>;
  cancel: () => void;
}

/** 每连接有界分片发送；逐片检查 64 KiB 背压并让出事件循环。 */
export class YjsFragmentSender {
  private readonly transfers = new Map<WsConnection, Map<string, Transfer>>();
  private readonly waiters = new Map<WsConnection, Map<string, SyncWaiter>>();

  constructor(private readonly onFrame: (docName: string, bytes: number) => void) {}

  /** 普通增量须等待在途基线结束，否则 replace 会覆盖先到的小更新。 */
  hasPending(ws: WsConnection, docName: string): boolean {
    return this.transfers.get(ws)?.has(docName) === true;
  }

  /** 握手须先于后台追赶获得下次发送机会，避免持续流式更新使握手饥饿。 */
  hasWaiter(ws: WsConnection, docName: string): boolean {
    return this.waiters.get(ws)?.has(docName) === true;
  }

  /** 同文档复用一次有界等待；保留向量计入连接预算，旧向量重算的差量仍包含新请求所需状态。 */
  afterPending(
    ws: WsConnection,
    docName: string,
    retry: (result: FragmentDeliveryResult) => Promise<LegacyFrameDelivery> | LegacyFrameDelivery,
    expired: () => LegacyFrameDelivery,
    failed: (error: unknown) => LegacyFrameDelivery,
    retainedBytes = 0,
  ): Promise<LegacyFrameDelivery> | undefined {
    const existing = this.waiters.get(ws)?.get(docName);
    if (existing) return existing.completion;
    const transfer = this.transfers.get(ws)?.get(docName);
    if (!transfer) return;
    if (this.heldBytes(ws) + retainedBytes > MAX_YJS_TRANSFER_BYTES) return Promise.resolve(expired());
    const waiting = this.waiters.get(ws) ?? new Map<string, SyncWaiter>();
    this.waiters.set(ws, waiting);
    let cancel!: () => void;
    const completion = new Promise<LegacyFrameDelivery>((resolve, reject) => {
      let ended = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        waiting.delete(docName);
        if (waiting.size === 0) this.waiters.delete(ws);
      };
      const timer = setTimeout(() => {
        ended = true;
        release();
        resolve(expired());
      }, YJS_TRANSFER_TIMEOUT_MS);
      cancel = () => {
        if (ended) return;
        ended = true;
        release();
        clearTimeout(timer);
        resolve(rejectedLegacyFrame(0, "backpressure"));
      };
      void transfer.completion
        .then((result) => {
          if (ended) return;
          release();
          return retry(result);
        })
        .then(
          (result) => {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            resolve(result!);
          },
          (error: unknown) => {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            reject(error);
          },
        );
    }).catch(failed);
    waiting.set(docName, { bytes: retainedBytes, completion, cancel });
    return completion;
  }

  /** 同文档共用发送槽；小更新等待排水后单帧发送，大更新按协议分片。 */
  send(
    ws: WsConnection,
    docName: string,
    generation: string,
    kind: "update" | "replace",
    payload: Uint8Array,
  ): Promise<FragmentDeliveryResult> {
    const active = this.transfers.get(ws) ?? new Map<string, Transfer>();
    const held = this.heldBytes(ws);
    if (active.has(docName) || held + payload.length > MAX_YJS_TRANSFER_BYTES) return Promise.resolve("backpressure");
    this.transfers.set(ws, active);
    let resolve!: (result: FragmentDeliveryResult) => void;
    const completion = new Promise<FragmentDeliveryResult>((settle) => {
      resolve = settle;
    });
    const transferId = crypto.randomUUID();
    let offset = 0;
    let finished = false;
    let pumpTimer: ReturnType<typeof setTimeout>;
    const deadlineTimer = setTimeout(() => fail("backpressure"), YJS_TRANSFER_TIMEOUT_MS);
    const finish = (result: FragmentDeliveryResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(pumpTimer);
      clearTimeout(deadlineTimer);
      active.delete(docName);
      if (active.size === 0) this.transfers.delete(ws);
      resolve(result);
    };
    // 有片段交付后只能通过新连接恢复；直接另起 update 会撞上接收端尚未过期的组装。
    const fail = (result: FragmentDeliveryResult) => {
      if (offset > 0 && ws.readyState === 1) ws.close(1013, SLOW_CONSUMER_RESYNC_TIMEOUT_REASON);
      finish(result);
    };
    active.set(docName, { bytes: payload.length, completion, finish });
    const pump = () => {
      if (finished) return;
      if (ws.readyState !== 1) return finish("backpressure");
      if ((ws.bufferedAmount ?? 0) > 64 * 1024) {
        pumpTimer = setTimeout(pump, 4);
        return;
      }
      let frame: Uint8Array;
      const singleFrame = payload.length <= MAX_YJS_SYNC_PAYLOAD_BYTES;
      try {
        frame = singleFrame
          ? kind === "replace"
            ? encodeYjsReplaceFrame(docName, generation, payload)
            : encodeYjsUpdateFrame(docName, generation, payload)
          : encodeYjsFragmentFrame({
              docName,
              generation,
              kind,
              transferId,
              offset,
              totalBytes: payload.length,
              chunk: payload.subarray(offset, offset + YJS_FRAGMENT_DATA_BYTES),
            });
      } catch {
        return fail("encode_failed");
      }
      try {
        ws.send(frame);
      } catch {
        return fail("backpressure");
      }
      this.onFrame(docName, frame.length);
      if (finished) return;
      offset += Math.min(singleFrame ? payload.length : YJS_FRAGMENT_DATA_BYTES, payload.length - offset);
      if (offset === payload.length) return finish("delivered");
      pumpTimer = setTimeout(pump, 0);
    };
    pumpTimer = setTimeout(pump, 0);
    return completion;
  }

  /** 换代与注销先取消旧传输；迟到分片不得覆盖新投影。 */
  cancelDocument(ws: WsConnection, docName: string): void {
    this.transfers.get(ws)?.get(docName)?.finish("backpressure");
    this.waiters.get(ws)?.get(docName)?.cancel();
  }

  /** 连接结束立即回收发送载荷与定时器。 */
  cancelConnection(ws: WsConnection): void {
    for (const transfer of this.transfers.get(ws)?.values() ?? []) transfer.finish("backpressure");
    for (const waiter of this.waiters.get(ws)?.values() ?? []) waiter.cancel();
  }

  /** 文档生命周期结束时撤销所有连接持有的对应载荷。 */
  unregisterDocument(docName: string): void {
    for (const ws of new Set([...this.transfers.keys(), ...this.waiters.keys()])) this.cancelDocument(ws, docName);
  }

  /** 发送与延后握手持有的字节共享单连接上限。 */
  private heldBytes(ws: WsConnection): number {
    const payloads = [...(this.transfers.get(ws)?.values() ?? [])].reduce((sum, transfer) => sum + transfer.bytes, 0);
    return [...(this.waiters.get(ws)?.values() ?? [])].reduce((sum, waiter) => sum + waiter.bytes, payloads);
  }
}
