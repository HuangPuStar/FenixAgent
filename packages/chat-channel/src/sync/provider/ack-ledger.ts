// packages/chat-channel/src/sync/provider/ack-ledger.ts
// deliveryId 记账与退额度（设计 §8.5、规格 §3.2）。
//
// 为什么账本留在服务端而不是信任客户端回执：ACK 只带 deliveryId 与结果，归还额度一律取服务端记录值，
// 客户端无法用「声称的字节数」放大后续可用窗口。账本与额度账本分离：ACK 只结清传输额度，不推进
// base/appliedSeq（设计 §8.6 第 4 条），业务完成边界由会话层另行证明。
//
// 代次口径：记录带着自己签发时的 transportEpoch，只有同代次 ACK 才归还；旧代次 ACK 不释放当前额度，
// 断连后由调用方成对 `reset`（设计 §8.5「断连清账，重连重新握手」）。
//
// 并发口径：加减只发生在 record/settle/reset，内部没有 await，检查与扣减在单线程下原子。
// 规模由连接窗口隐含限制（在途投递数 ≈ 窗口 / 最小帧）；调用方仍需按 ACK 超时断开单连接，
// 本模块不做超时（没有时间源）。

import { SyncProtocolError } from "../protocol/errors";
import { assertIdentifier } from "../protocol/identity";
import type { TaskClass } from "./quota";

export interface AckRecord {
  /** 签发该帧时的传输代次；ACK 必须原样带回才可归还。 */
  readonly transportEpoch: string;
  readonly deliveryId: string;
  readonly docId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  /** 服务端记录的编码字节数（含 wire/envelope），归还时以此为准。 */
  readonly bytes: number;
  /**
   * 该类目用于把字节归还到正确的份额账目。
   *
   * 这是规格缺口补充：规格给出的字段里没有它，而 `onRelease` 必须知道类目，否则历史类额度会被归还到
   * 实时类，公平账目随之失真。设为必填让接线期类型检查就能拦住漏传，而不是在运行期静默错记。
   */
  readonly taskClass: TaskClass;
}

export interface AckLedger {
  /** 记录已发送帧；重复 deliveryId 只记一次。 */
  record(entry: AckRecord): void;
  /** 处理客户端 ACK；只按自身账本退额度。返回实际归还字节。 */
  settle(params: { transportEpoch: string; deliveryId: string; result: "processed" | "rejected" }): number;
  /**
   * 服务端自结算：投递在交接前就被丢弃（出帧网关搁置位被顶替），从未上线，客户端无从回执。
   *
   * 与 `settle` 的区别只在结算原因，不引入第二套账目：记录、归还路径与幂等口径完全一致。额度只覆盖「已发送
   * 未回执」字节（设计 §8.5），把从未发出的投递留在窗口里会让慢端连接永久少一段额度（规格 §2.4「`send`
   * 返回 false 时归还上次预留」）。返回实际归还字节；查无此投递或代次不同返回 0。
   */
  abandon(params: { transportEpoch: string; deliveryId: string }): number;
  /** 已记录但未结算的投递数。 */
  outstandingCount(): number;
  reset(): void;
}

/** 记录字段违规统一出口：`MALFORMED_FRAME` 表示调用方递来的投递描述本身不成立（帧层已拒绝畸形帧）。 */
function rejectRecord(message: string): never {
  throw new SyncProtocolError("MALFORMED_FRAME", { message: `ack ledger rejected: ${message}` });
}

function assertSeq(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    rejectRecord(`${field} must be a non-negative safe integer, received ${String(value)}`);
  }
  return value;
}

/** 记录与既有条目是否描述同一投递：重复投递必须逐字段一致，否则视为 deliveryId 被复用（调用方缺陷）。 */
function isSameDelivery(a: AckRecord, b: AckRecord): boolean {
  return (
    a.transportEpoch === b.transportEpoch &&
    a.docId === b.docId &&
    a.fromSeq === b.fromSeq &&
    a.toSeq === b.toSeq &&
    a.bytes === b.bytes &&
    a.taskClass === b.taskClass
  );
}

export function createAckLedger(options: {
  readonly onRelease: (taskClass: TaskClass, bytes: number) => void;
}): AckLedger {
  const entries = new Map<string, AckRecord>();

  /**
   * 归还一条已记录投递的字节（`settle` 与 `abandon` 共用的唯一释放路径）。
   *
   * 先归还额度、再删记录：`onRelease` 是调用方代码，它的额度账本可能与投递账本不同步（例如只 reset 了额度而
   * 未 reset 本账本，或类目余额不足）而抛错；先删记录会让这一帧永久无法结清，窗口额度随之静默泄漏。记录保留到
   * 归还成功之后，调用方修正账目后可用同一原因重试收敛。回调只拿到类目与字节数，不含 deliveryId，因此不存在
   * 回调期重入结清同一投递的路径。
   */
  function release(transportEpoch: string, deliveryId: string): number {
    assertIdentifier(transportEpoch, "transportEpoch");
    assertIdentifier(deliveryId, "deliveryId");
    const entry = entries.get(deliveryId);
    // 查无此投递：未来/伪造/已结算过的 ACK 或重复自结算，都不产生额度。
    if (entry === undefined) {
      return 0;
    }
    // 旧代次的结算不释放当前代次的额度：它对应的帧属于上一代次账本，凭它加额度会放大窗口。
    if (entry.transportEpoch !== transportEpoch) {
      return 0;
    }
    options.onRelease(entry.taskClass, entry.bytes);
    entries.delete(deliveryId);
    return entry.bytes;
  }

  return {
    record(entry: AckRecord): void {
      assertIdentifier(entry.transportEpoch, "transportEpoch");
      assertIdentifier(entry.deliveryId, "deliveryId");
      assertIdentifier(entry.docId, "docId");
      const fromSeq = assertSeq(entry.fromSeq, "fromSeq");
      const toSeq = assertSeq(entry.toSeq, "toSeq");
      if (toSeq < fromSeq) {
        rejectRecord(`toSeq ${toSeq} is before fromSeq ${fromSeq}`);
      }
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
        rejectRecord(`bytes must be a positive safe integer, received ${String(entry.bytes)}`);
      }
      const existing = entries.get(entry.deliveryId);
      if (existing !== undefined) {
        // 重复记账只确认一次（重复帧幂等）；但同 id 不同内容说明 deliveryId 被复用，会掩盖真实投递，
        // 因此不覆盖既有条目、也不静默忽略。
        if (!isSameDelivery(existing, entry)) {
          rejectRecord(`deliveryId ${entry.deliveryId} is already recorded with different content`);
        }
        return;
      }
      entries.set(entry.deliveryId, { ...entry });
    },

    settle(params: { transportEpoch: string; deliveryId: string; result: "processed" | "rejected" }): number {
      // processed 与 rejected 都结清传输额度（设计 §8.6 第 4 条）：rejected 只表示本轮 apply 失败，字节已经
      // 离开服务端在途账目，继续占额度只会让该连接更快耗尽窗口。业务结果由会话层处理。
      return release(params.transportEpoch, params.deliveryId);
    },

    abandon(params: { transportEpoch: string; deliveryId: string }): number {
      return release(params.transportEpoch, params.deliveryId);
    },

    outstandingCount(): number {
      return entries.size;
    },

    reset(): void {
      // 断连清账：不回调 `onRelease`，因为调用方会同时 reset 额度账本；再回调一次会重复归还。
      entries.clear();
    },
  };
}
