// packages/chat-channel/src/sync/provider/control-governor.ts
// 控制流限频与在途窗口（设计 §10.5「控制流使用独立份额」、规格 §2.6）。
//
// 控制帧（HELLO/MANIFEST/SUBSCRIBE/SEALED/ACK/RESYNC/GENERATION_REPLACE）在额度层有独立份额，在连接层
// 另有本层这两把锁，二者不互相替代：
// 1. 帧率令牌桶：容量与速率都取 `capacity/profile.ts:149` 的 `controlFramesPerSecond`（每秒 100 帧）。
//    令牌只在调用时按 `clock.now()` 的差值惰性补充，**不创建定时器**——本层是无资源的纯状态机，定时器会把
//    生命周期与释放责任从调用方挪进模块内，也让「推进假时钟」的测试口径失效。
// 2. 窗口字节：取 `capacity/profile.ts:148` 的 `controlWindowPerConnectionBytes`（32KiB/连接），
//    账目口径是「已申请未结清」的控制帧字节。
//
// 令牌与字节量纲不同，刻意不互相退换：令牌限**发送尝试速率**，字节限**在途量**。因此 `release` 只归还字节、
// 不退还令牌——令牌随时间自然回收；若发行失败就退令牌，持续失败的调用方就能把窗口当额度无限占用帧率。
//
// 拒绝不是异常：令牌或窗口不足返回 false，账目不变、可原样重试。只有参数违规（非正数、非整数、非法字节数）
// 才抛 `ADMISSION_REJECTED`，与 quota/rotation 的「不足是流控、违规是调用方缺陷」口径一致。
// 时间回退（`now` 变小）不补令牌：回拨若能刷出额度，速率限制就形同虚设。

import type { Clock } from "../clock";
import { SyncProtocolError } from "../protocol/errors";

/** 观测快照：窗口配置值与当前账目，供测试与运行时诊断；不携带任何判定状态。 */
export interface ControlGovernorSnapshot {
  /** 窗口上限（配置值，不随账目变化）。 */
  readonly windowBytes: number;
  /** 已申请未结清的控制帧字节。 */
  readonly usedBytes: number;
  /** 当前可用的**整帧**令牌数：不足一帧的余量不进位，避免报告出实际发不出的帧数。 */
  readonly availableTokens: number;
}

/**
 * 配置：三个字段都由装配层注入，且两个数值只能来自 `capacity/profile.ts:148-149`。
 * 本层不提供默认值——否则会出现第二份真相，调容量表时漏改一处就会静默用旧值。
 */
export interface ControlGovernorOptions {
  readonly clock: Clock;
  readonly framesPerSecond: number;
  readonly windowBytes: number;
}

export interface ControlGovernor {
  /**
   * 发送前申请：帧率令牌与窗口字节同时满足才授予，并立刻计入在途账目。
   *
   * 被拒返回 false 且不改变任何账目（也不消耗令牌），可原样重试。超过整窗的单帧永远被拒：字节数是合法输入，
   * 只是放不下，属于拒绝而非参数违规。
   */
  tryAcquire(encodedBytes: number): boolean;
  /** 结清一帧控制字节（发送失败回退或对端已收）；令牌不退还，见文件头。 */
  release(bytes: number): void;
  snapshot(): ControlGovernorSnapshot;
  /** 断连清账：字节归零、令牌回满桶、补充基准点重新起算。 */
  reset(): void;
}

/**
 * 参数违规统一出口。与「额度不足返回 false」分开：不足是正常流控，违规必须立刻暴露——负数会凭空造出额度，
 * NaN 会让所有比较恒为 false 从而放行一切。
 */
function rejectControl(message: string): never {
  throw new SyncProtocolError("ADMISSION_REJECTED", { message: `control governor rejected: ${message}` });
}

/** 正安全整数：`Number.isSafeInteger` 同时排除 NaN、小数与超精度值（超精度会静默舍入字节数）。 */
function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    rejectControl(`${field} must be a positive safe integer, received ${String(value)}`);
  }
  return value;
}

export function createControlGovernor(options: ControlGovernorOptions): ControlGovernor {
  const { clock } = options;
  const framesPerSecond = assertPositiveInteger(options.framesPerSecond, "framesPerSecond");
  const windowBytes = assertPositiveInteger(options.windowBytes, "windowBytes");
  /** 每毫秒补充的令牌数：保留小数累计，毫秒级推进不会因取整而丢速率。 */
  const tokensPerMs = framesPerSecond / 1000;

  /** 初始满桶：连接建立期允许一次不超过 `framesPerSecond` 的握手突发，此后受速率约束。 */
  let tokens = framesPerSecond;
  /** 最近一次补充基准点，只在时间真正前进时推进（时间回退不得回挪它）。 */
  let refilledAt = clock.now();
  let usedBytes = 0;

  /**
   * 惰性补充：按 `now - refilledAt` 一次性补齐，上限 `framesPerSecond`。
   *
   * 差值非正或非有限（时间回退、时钟故障）时既不加令牌也不移动基准点：宁可让这段真实时间白走，
   * 也不让回拨变成刷额度的手段。
   */
  function refill(): void {
    const now = clock.now();
    const elapsedMs = now - refilledAt;
    if (!(elapsedMs > 0)) {
      return;
    }
    refilledAt = now;
    tokens = Math.min(framesPerSecond, tokens + elapsedMs * tokensPerMs);
  }

  return {
    tryAcquire(encodedBytes: number): boolean {
      const bytes = assertPositiveInteger(encodedBytes, "encodedBytes");
      refill();
      if (tokens < 1) {
        return false;
      }
      // 用剩余量做差再比较，避免 `usedBytes + bytes` 溢出安全整数范围后比较失真。
      if (bytes > windowBytes - usedBytes) {
        return false;
      }
      tokens -= 1;
      usedBytes += bytes;
      return true;
    },

    release(bytes: number): void {
      const released = assertPositiveInteger(bytes, "release bytes");
      // 多退字节会凭空造出容量，并让后续结清与账目永久错位，因此在源头拒绝而不是夹到零。
      if (released > usedBytes) {
        rejectControl(`release of ${released} bytes exceeds used ${usedBytes} bytes`);
      }
      usedBytes -= released;
    },

    snapshot(): ControlGovernorSnapshot {
      // 快照先补充：否则观测到的令牌数会随「上次调用时间」而滞后，测试与诊断都不可信。
      refill();
      return { windowBytes, usedBytes, availableTokens: Math.floor(tokens) };
    },

    reset(): void {
      usedBytes = 0;
      tokens = framesPerSecond;
      refilledAt = clock.now();
    },
  };
}
