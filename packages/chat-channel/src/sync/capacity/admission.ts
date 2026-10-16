// packages/chat-channel/src/sync/capacity/admission.ts
// 池额度预留：把设计 §10.1「先取得下一阶段额度，再释放上一阶段额度」变成可核对的账目。
//
// 账目只在同步路径上加减：reserve/handoff/release 内部没有 await，「检查上限—扣减」在单线程下是原子的。
// 若将来要在这里等待回收或排队，必须一并引入顺序号或显式锁，否则会退化成超额接纳。
// 超限一律立刻抛 ADMISSION_REJECTED（设计 §10.6 的过载语义）：不排队、不等待、不预扣，
// 由调用方决定降级还是失败，避免同步链路上出现无界排队。

import { SyncProtocolError } from "../protocol/errors";
import type { SERVER_POOL_BYTES, SyncCapacityProfile } from "./profile";

/** 服务端子池名：与 `SERVER_POOL_BYTES` 的键一一对应，新增池时编译期即暴露漏配。 */
export type ServerPoolName = keyof typeof SERVER_POOL_BYTES;

/** 一次已生效的额度占用；`release()` 幂等，重复调用不会重复归还。 */
export interface Reservation {
  readonly pool: ServerPoolName;
  readonly bytes: number;
  release(): void;
}

/**
 * 账目初值：键集必须与 `SERVER_POOL_BYTES` 完全一致——漏写一个池会在编译期报错，
 * 避免「某个池没有账目」在运行期表现为 `undefined + n = NaN` 并静默放行。
 */
const ZERO_USAGE: Record<ServerPoolName, number> = {
  frameParse: 0,
  ingressSpool: 0,
  historyBuild: 0,
  hotDocLive: 0,
  persistSeal: 0,
  transportCache: 0,
  controlIndex: 0,
  safetyReserve: 0,
};

/** 接纳失败统一出口：message 只含池名与字节数（无正文、无凭据），可直接进日志。 */
function rejectAdmission(message: string): never {
  throw new SyncProtocolError("ADMISSION_REJECTED", { message: `admission rejected: ${message}` });
}

/**
 * 额度必须是正整数：负值会变成「归还」从而凭空增加可用额度，小数会累积出不可解释的余额，
 * NaN 会让所有比较恒为 false 并放行一切。这类调用方缺陷仍按 ADMISSION_REJECTED 抛出，
 * 让调用方只需处理一种异常类型，message 则明确指出是额度本身非法。
 */
function assertReservableBytes(pool: ServerPoolName, bytes: number): void {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    rejectAdmission(`reservation size for pool ${pool} must be a positive integer, received ${String(bytes)}`);
  }
}

/**
 * 单进程的池额度账目。每个进程持有一个实例，所有阶段（解析、构建、持久化、发送）共用同一份账目，
 * 池之间不共享额度：跨池交接必须显式调用 `handoff`，否则无法在日志里解释额度去了哪里。
 */
export class AdmissionController {
  /** 池上限快照：构造后调用方改写传入对象不得改变口径，否则已计提用量可能反超上限。 */
  private readonly limits: Record<ServerPoolName, number>;
  private readonly usage: Record<ServerPoolName, number>;
  /** 本控制器签发且尚未释放的预留：拦住已释放预留或他处预留被再次交接从而凭空造出额度。 */
  private readonly liveReservations = new WeakSet<Reservation>();

  constructor(profile: SyncCapacityProfile) {
    // 构造期刻意不做 profile 校验：校验是启用边界的一次性动作（validateCapacityProfile），
    // 放在这里会让每个控制器重复全量走查，并把配置错误推迟到请求路径上才抛出。
    this.limits = { ...profile.serverPools };
    this.usage = { ...ZERO_USAGE };
  }

  /** 预留额度；超出池上限抛 ADMISSION_REJECTED，不排队、不等待（设计 §10.6）。 */
  reserve(pool: ServerPoolName, bytes: number): Reservation {
    const name = this.assertKnownPool(pool);
    assertReservableBytes(name, bytes);
    const used = this.usage[name];
    const limit = this.limits[name];
    if (used + bytes > limit) {
      rejectAdmission(`pool ${name} rejected ${bytes} bytes: ${limit - used} of ${limit} bytes free`);
    }
    this.usage[name] = used + bytes;
    return this.issueReservation(name, bytes);
  }

  /**
   * 交接：先取得下一阶段额度，成功后才释放当前预留。
   *
   * 顺序不可交换——目标池已满时若已释放原预留，额度会凭空消失（后续阶段提前被拒，而帐面上早已归还）。
   * 复制阶段两边同时计费由调用方用两次 `reserve` 表达，不走本方法。
   */
  handoff(from: Reservation, to: ServerPoolName, bytes: number): Reservation {
    if (!this.liveReservations.has(from)) {
      // 已释放或非本控制器签发的预留，无法判断它占着哪个池的多少额度，继续交接等于凭空造额度。
      rejectAdmission("handoff source reservation is not an outstanding reservation of this controller");
    }
    const next = this.reserve(to, bytes);
    from.release();
    return next;
  }

  used(pool: ServerPoolName): number {
    return this.usage[this.assertKnownPool(pool)];
  }

  available(pool: ServerPoolName): number {
    const name = this.assertKnownPool(pool);
    return this.limits[name] - this.usage[name];
  }

  /** 未知名经类型系统无法到达，但经配置或 JSON 流入的字符串在运行期仍可能出现。 */
  private assertKnownPool(pool: ServerPoolName): ServerPoolName {
    if (!(pool in this.limits)) {
      rejectAdmission(`unknown server pool "${String(pool)}"`);
    }
    return pool;
  }

  /** 签发预留：`liveReservations` 同时充当「是否已释放」的状态，重复释放因而不可能重复归还。 */
  private issueReservation(pool: ServerPoolName, bytes: number): Reservation {
    const reservation: Reservation = {
      pool,
      bytes,
      release: (): void => {
        if (!this.liveReservations.delete(reservation)) {
          return; // 已释放过：重复归还会让 used 变负，等于放大可用额度。
        }
        this.usage[pool] -= bytes;
      },
    };
    this.liveReservations.add(reservation);
    // 冻结：调用方不得改写已签发预留的池名或字节数，否则账目与预留描述会不一致。
    return Object.freeze(reservation);
  }
}
