import * as Y from "yjs";
import type { WsConnection } from "./connection-types";
import { deliveredLegacyFrame, type LegacyFrameDelivery, rejectedLegacyFrame } from "./fragment-delivery";

interface TargetedDeliveryOptions {
  deliver: (ws: WsConnection, name: string, generation: string, update: Uint8Array) => LegacyFrameDelivery;
  followup: (ws: WsConnection, name: string, generation: string, update: Uint8Array) => LegacyFrameDelivery;
  wait: (
    ws: WsConnection,
    name: string,
    retry: () => LegacyFrameDelivery,
    retainedBytes: number,
  ) => LegacyFrameDelivery | null;
  generation: (name: string) => string | undefined;
  covered: (ws: WsConnection, name: string) => void;
  rejected: (
    ws: WsConnection,
    name: string,
    generation: string,
    delivery: LegacyFrameDelivery,
    recovered?: (delivery: LegacyFrameDelivery) => void,
  ) => void;
}

/** 基线后固定一次差量作为同步边界，复用分片等待槽位、预算和总时限。 */
export class TargetedDelivery {
  private readonly observed = new WeakMap<
    Promise<LegacyFrameDelivery>,
    {
      delivery: LegacyFrameDelivery;
      recovered?: (delivery: LegacyFrameDelivery) => void;
    }
  >();

  constructor(private readonly options: TargetedDeliveryOptions) {}

  /** 完整快照可从载荷取得基线向量；差量调用方须提供已覆盖的完整向量。 */
  send(
    ws: WsConnection,
    ydoc: Y.Doc,
    name: string,
    generation: string,
    payload: Uint8Array,
    onRecovered?: (delivery: LegacyFrameDelivery) => void,
    baseline?: Uint8Array,
  ): LegacyFrameDelivery {
    const delivery = this.options.deliver(ws, name, generation, payload);
    if (!delivery.completion) return this.observe(ws, name, generation, delivery, onRecovered);
    let vector: Uint8Array | undefined = baseline ?? Y.encodeStateVectorFromUpdate(payload);
    const waiting = this.options.wait(
      ws,
      name,
      () => {
        const current = this.options.generation(name);
        if (current !== undefined && current !== generation) return rejectedLegacyFrame(0, "backpressure");
        const update = Y.encodeStateAsUpdate(ydoc, vector);
        // waiter 已归还向量预算；差量只捕获本时点，之后的实时变化不延长本轮证明。
        vector = undefined;
        this.options.covered(ws, name);
        // Yjs v1 的空更新只有 struct-count=0、delete-set-count=0；静默文档不额外发帧。
        if (update.length === 2 && update[0] === 0 && update[1] === 0) return deliveredLegacyFrame(0);
        return this.options.followup(ws, name, generation, update);
      },
      vector.byteLength,
    );
    return this.observe(ws, name, generation, waiting ?? delivery, onRecovered);
  }

  /** 同一等待任务只绑定一个观察者，最终失败才进入迟到恢复。 */
  observe(
    ws: WsConnection,
    name: string,
    generation: string,
    delivery: LegacyFrameDelivery,
    onRecovered?: (delivery: LegacyFrameDelivery) => void,
  ): LegacyFrameDelivery {
    const pending = delivery.completion;
    const existing = pending && this.observed.get(pending);
    if (existing) {
      existing.recovered ??= onRecovered;
      return existing.delivery;
    }
    const observer = { delivery, recovered: onRecovered };
    const settled = (result: LegacyFrameDelivery) => {
      if (!result.ok) this.options.rejected(ws, name, generation, result, observer.recovered);
      return result;
    };
    if (!pending) return settled(delivery);
    const observed = { ...delivery, completion: pending.then(settled) };
    observer.delivery = observed;
    this.observed.set(pending, observer);
    return observed;
  }
}
