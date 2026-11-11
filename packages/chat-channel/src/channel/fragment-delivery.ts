import {
  encodeYjsFragmentFrame,
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

/** 每连接有界分片发送；逐片检查 64 KiB 背压并让出事件循环。 */
export class YjsFragmentSender {
  private readonly transfers = new Map<WsConnection, Map<string, Transfer>>();
  private readonly waiters = new Map<WsConnection, Map<string, number>>();

  constructor(private readonly onFrame: (docName: string, bytes: number) => void) {}

  /** 普通增量须等待在途基线结束，否则 replace 会覆盖先到的小更新。 */
  hasPending(ws: WsConnection, docName: string): boolean {
    return this.transfers.get(ws)?.has(docName) === true;
  }

  /** 握手须先于后台追赶获得下次发送机会，避免持续流式更新使握手饥饿。 */
  hasWaiter(ws: WsConnection, docName: string): boolean {
    return (this.waiters.get(ws)?.get(docName) ?? 0) > 0;
  }

  /** 等待在途基线后重算差量；占用优先级直到回调开始，且总等待不超过传输时限。 */
  afterPending<T>(
    ws: WsConnection,
    docName: string,
    retry: (result: FragmentDeliveryResult) => Promise<T> | T,
    expired: () => T,
  ): Promise<T> | undefined {
    const transfer = this.transfers.get(ws)?.get(docName);
    if (!transfer) return;
    const waiting = this.waiters.get(ws) ?? new Map<string, number>();
    this.waiters.set(ws, waiting);
    waiting.set(docName, (waiting.get(docName) ?? 0) + 1);
    return new Promise<T>((resolve, reject) => {
      let ended = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const count = (waiting.get(docName) ?? 1) - 1;
        if (count > 0) waiting.set(docName, count);
        else waiting.delete(docName);
        if (waiting.size === 0) this.waiters.delete(ws);
      };
      const timer = setTimeout(() => {
        ended = true;
        release();
        resolve(expired());
      }, YJS_TRANSFER_TIMEOUT_MS);
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
            resolve(result as T);
          },
          (error: unknown) => {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            reject(error);
          },
        );
    });
  }

  /** 同一文档最多一个在途大更新，后续增量由既有快照追赶收敛。 */
  send(
    ws: WsConnection,
    docName: string,
    generation: string,
    kind: "update" | "replace",
    payload: Uint8Array,
  ): Promise<FragmentDeliveryResult> {
    const active = this.transfers.get(ws) ?? new Map<string, Transfer>();
    const held = [...active.values()].reduce((sum, transfer) => sum + transfer.bytes, 0);
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
      try {
        frame = encodeYjsFragmentFrame({
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
      offset += Math.min(YJS_FRAGMENT_DATA_BYTES, payload.length - offset);
      if (offset === payload.length) return finish("delivered");
      pumpTimer = setTimeout(pump, 0);
    };
    pumpTimer = setTimeout(pump, 0);
    return completion;
  }

  /** 换代与注销先取消旧传输；迟到分片不得覆盖新投影。 */
  cancelDocument(ws: WsConnection, docName: string): void {
    this.transfers.get(ws)?.get(docName)?.finish("backpressure");
  }

  /** 连接结束立即回收发送载荷与定时器。 */
  cancelConnection(ws: WsConnection): void {
    for (const transfer of this.transfers.get(ws)?.values() ?? []) transfer.finish("backpressure");
  }

  /** 文档生命周期结束时撤销所有连接持有的对应载荷。 */
  unregisterDocument(docName: string): void {
    for (const ws of this.transfers.keys()) this.cancelDocument(ws, docName);
  }
}
