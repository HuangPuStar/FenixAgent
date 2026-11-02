// packages/chat-channel/src/sync/provider/ack-timeout.ts
// ACK 超时登记与惰性过期扫描（设计 §8.5、规格 §2.6）。
//
// 为什么单独一层：AckLedger 只管字节账目且明确声明不做超时（ack-ledger.ts:12-13），ProviderSession 也没有
// deadline 原语（session.ts:423 的 onAck 只结清账本）。到期判定必须有唯一的时钟与唯一的期限来源，因此
// 期限取 `capacity/profile.ts:152` 的 `ackDeadlineMs`（30s，注释对应「30s 无进展断开该连接」）由调用方注入。
//
// 本层只回答「谁超期了」，不执行任何动作：断开连接需要传输层与代次视角（同一 deliveryId 的帧属于签发时的
// `transportEpoch`），二者都在调用方；把关闭逻辑塞进本层会让「判定」与「执行」耦合到无法单独验证。
//
// 幂等口径：同 deliveryId 且同代次重复登记保留**首次**时刻与代次，不续期。重传同一 deliveryId 不能把自己
// 的 ACK 期限一再推后——否则一个永远收不到 ACK 的投递可凭重传无限期占住在途额度与账本条目。
//
// 代次口径：同 deliveryId 却换了 transportEpoch 说明该 id 被跨代次复用，属调用方缺陷，与 `ack-ledger.ts`
// 同口径抛 `MALFORMED_FRAME` 而不是静默忽略——忽略既藏起缺陷，又会让超期报告把责任记到错误的连接上。
//
// 扫描是只读查询：超期条目保留到 `settle` 或 `reset` 为止，与 AckLedger 的「断连时成对清账」口径一致。
// 若扫描顺手删除，调用方就无法在一次 tick 里既取到证据又决定动作，第二次观测还会静默变成空集。

import type { Clock } from "../clock";
import { syncAckDuration } from "../metrics";
import { SyncProtocolError } from "../protocol/errors";
import { assertIdentifier } from "../protocol/identity";

/** 一条超期投递：代次一并返回，调用方据此判断该断开的是否是当前连接。 */
export interface AckTimeoutEntry {
  readonly deliveryId: string;
  readonly transportEpoch: string;
}

/** 配置：期限只能来自 `capacity/profile.ts:152`，本层不提供默认值以免出现第二份真相。 */
export interface AckTimeoutTrackerOptions {
  readonly clock: Clock;
  readonly ackDeadlineMs: number;
}

export interface AckTimeoutTracker {
  /**
   * 登记已发出的需回执投递；同 deliveryId 且同代次幂等（保留首次登记时刻与代次，不续期）。
   * 同 deliveryId 换代次时抛 `MALFORMED_FRAME`（deliveryId 跨代次复用是调用方缺陷）。
   */
  track(deliveryId: string, transportEpoch: string): void;
  /** 收到 ACK 或作废即注销；未登记的 deliveryId 返回 false，不抛错（重复 ACK 与迟到 ACK 都走这条路）。 */
  settle(deliveryId: string): boolean;
  /** 惰性过期扫描：返回超期投递（登记顺序）；调用方据 transportEpoch 判定是否需要断开。 */
  scan(): readonly AckTimeoutEntry[];
  /** 已登记未结算的投递数，含已超期但仍未结算的条目（扫描不改变账目）。 */
  outstandingCount(): number;
  /** 断连清账。 */
  reset(): void;
}

/** 期限违规统一出口：非正或非整数期限会让所有投递「立刻超期」或「永不超期」，必须装配期暴露。 */
function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SyncProtocolError("ADMISSION_REJECTED", {
      message: `ack timeout rejected: ${field} must be a positive safe integer, received ${String(value)}`,
    });
  }
  return value;
}

export function createAckTimeoutTracker(options: AckTimeoutTrackerOptions): AckTimeoutTracker {
  const { clock } = options;
  const ackDeadlineMs = assertPositiveInteger(options.ackDeadlineMs, "ackDeadlineMs");
  /** 登记顺序即扫描顺序（Map 保序）：日志与断言都需要稳定顺序，不额外排序。 */
  const entries = new Map<string, { readonly transportEpoch: string; readonly trackedAt: number }>();

  return {
    track(deliveryId: string, transportEpoch: string): void {
      // 标识先校验：非法标识会在日志与 ERROR 帧里变成无法追溯的条目，且此处已是协议边界。
      assertIdentifier(deliveryId, "deliveryId");
      assertIdentifier(transportEpoch, "transportEpoch");
      const existing = entries.get(deliveryId);
      if (existing !== undefined) {
        if (existing.transportEpoch !== transportEpoch) {
          // 同 id 换代次：不覆盖既有条目、也不静默忽略（见文件头代次口径）。错误信息只含 id 与代次，
          // 供日志与 ERROR 帧定位，不携带任何帧正文。
          throw new SyncProtocolError("MALFORMED_FRAME", {
            message:
              `ack timeout rejected: deliveryId ${deliveryId} is already tracked with transportEpoch ` +
              `${existing.transportEpoch}, received ${transportEpoch}`,
          });
        }
        // 同代次重复登记直接忽略：既不续期也不换代次，重传不能延长自己的期限（见文件头幂等口径）。
        return;
      }
      entries.set(deliveryId, { transportEpoch, trackedAt: clock.now() });
    },

    settle(deliveryId: string): boolean {
      assertIdentifier(deliveryId, "deliveryId");
      const entry = entries.get(deliveryId);
      if (entry)
        syncAckDuration.record(Math.max(0, clock.now() - entry.trackedAt) / 1000, {
          channel: "sync",
          message: "delivery",
        });
      return entries.delete(deliveryId);
    },

    scan(): readonly AckTimeoutEntry[] {
      const now = clock.now();
      const expired: AckTimeoutEntry[] = [];
      for (const [deliveryId, entry] of entries) {
        // 边界取等号即超期：与「无进展满 ackDeadlineMs 就断」一致，不给调用方留下自行解释 `>` 与 `>=` 的余地。
        // 时间回退时差值为负，判定不成立——回拨只会推迟超期，不会误断连接。
        if (now - entry.trackedAt >= ackDeadlineMs) {
          expired.push({ deliveryId, transportEpoch: entry.transportEpoch });
        }
      }
      return expired;
    },

    outstandingCount(): number {
      return entries.size;
    },

    reset(): void {
      entries.clear();
    },
  };
}
