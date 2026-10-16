// packages/chat-channel/src/sync/clock.ts
// 同步协议的基础设施契约：时间、随机性与摘要。
//
// 三者都由调用方注入，模块内不得直取全局：
// - 租约过期、deadline、节流窗口依赖时间，直调 `Date.now()` 会让测试无法确定性推进；
// - 标识生成依赖随机性，直用全局 CSPRNG 会让同一断言在不同运行下不可复现；
// - 摘要必须可替换，才能在不改协议代码的前提下核对 canonical 字节。
// 本文件是 `sync/` 内部唯一的「外部效应」出口（基础设施层，不 import 其它 sync 子目录）。

import { createHash } from "node:crypto";

/** 时间源：所有租约、deadline、节流都必须经它取时，便于测试与替换。 */
export interface Clock {
  now(): number;
}

/** 生产时间源：毫秒级 Unix 时间戳。 */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/** 随机源：标识生成只经它取随机性，测试用确定性实现。 */
export interface RandomSource {
  bytes(length: number): Uint8Array;
}

/** 长度非法时立刻失败：错配长度会静默产出偏短标识，破坏标识唯一性的前提。 */
function assertRequestedLength(length: number): void {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`random source length must be a non-negative integer, received ${String(length)}`);
  }
}

/** Web Crypto 对单次 `getRandomValues` 的固定配额上限，超过时原生实现抛 QuotaExceededError。 */
const MAX_RANDOM_REQUEST_BYTES = 65536;

/** 生产随机源：`globalThis.crypto.getRandomValues`（不依赖 node:crypto，Bun 与浏览器均可用）。 */
export const cryptoRandomSource: RandomSource = {
  bytes(length: number): Uint8Array {
    assertRequestedLength(length);
    if (length > MAX_RANDOM_REQUEST_BYTES) {
      throw new RangeError(
        `random source request of ${length} bytes exceeds the ${MAX_RANDOM_REQUEST_BYTES} byte per-call limit`,
      );
    }
    const out = new Uint8Array(length);
    globalThis.crypto.getRandomValues(out);
    return out;
  },
};

/** 摘要函数：canonical 字节的 SHA-256。 */
export type DigestFn = (bytes: Uint8Array) => string;

/** 生产摘要函数：64 字符小写十六进制的 SHA-256。 */
export const sha256Digest: DigestFn = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * 测试用确定性随机源：按 `SHA-256(seed || 8 字节大端计数器)` 逐块展开字节流，
 * 同一 seed 在任何进程与调用顺序下都得到同一序列，因此断言可复现。
 *
 * 只用于测试与本地复现：本函数不提供不可预测性，生产必须注入 `cryptoRandomSource`。
 */
export function deterministicRandomSource(seed: string | number): RandomSource {
  const seedBytes = new TextEncoder().encode(String(seed));
  const counterBytes = new Uint8Array(8);
  const counterView = new DataView(counterBytes.buffer);
  let counter = 0;
  return {
    bytes(length: number): Uint8Array {
      assertRequestedLength(length);
      const out = new Uint8Array(length);
      // 计数器每块递增，保证同一次会话内连续调用不会重复同一字节块。
      for (let offset = 0; offset < length; ) {
        counterView.setBigUint64(0, BigInt(counter));
        counter += 1;
        const block = createHash("sha256").update(seedBytes).update(counterBytes).digest();
        const take = Math.min(block.length, length - offset);
        out.set(block.subarray(0, take), offset);
        offset += take;
      }
      return out;
    },
  };
}
