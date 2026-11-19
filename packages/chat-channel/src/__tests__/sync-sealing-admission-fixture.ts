import * as Y from "yjs";
import { AdmissionController, type ServerPoolName } from "../sync/capacity/admission";

/** 每次使用全新 Doc，避免 padding 调整产生删除历史而偏离目标编码字节数。 */
export function exactSealingSnapshot(byteLength: number, character: string): Uint8Array {
  if (character.length !== 1 || character.charCodeAt(0) > 127) throw new Error("padding must be one ASCII byte");
  let low = 0,
    high = byteLength;
  while (low <= high) {
    const length = Math.floor((low + high) / 2),
      doc = new Y.Doc();
    doc.clientID = 12345;
    try {
      doc.getText("padding").insert(0, character.repeat(length));
      const snapshot = Y.encodeStateAsUpdate(doc);
      if (snapshot.byteLength === byteLength) return snapshot;
      if (snapshot.byteLength < byteLength) low = length + 1;
      else high = length - 1;
    } finally {
      doc.destroy();
    }
  }
  throw new Error(`no exact Yjs padding snapshot for ${byteLength} bytes`);
}

/** 只旁观真实 reserve 的峰值；接纳、释放和额度上限仍完全由原控制器执行。 */
export class SealingAdmission extends AdmissionController {
  private observe: ((pool: ServerPoolName, used: number) => void) | undefined;

  override reserve(pool: ServerPoolName, bytes: number) {
    const charge = super.reserve(pool, bytes);
    this.observe?.(pool, this.used(pool));
    return charge;
  }

  /** 独立成功探测返回整笔事务所需的峰值增量，以及提交时释放的旧元数据。 */
  async measurePeak(pool: ServerPoolName, operation: () => Promise<unknown>) {
    if (this.observe) throw new Error("admission probe is already active");
    const before = this.used(pool);
    let peak = before;
    this.observe = (name, used) => {
      if (name === pool) peak = Math.max(peak, used);
    };
    try {
      await operation();
      return { peakBytes: peak - before, releasedBytes: peak - this.used(pool) };
    } finally {
      this.observe = undefined;
    }
  }
}
