import { randomUUID } from "node:crypto";
import type { ActionAck, ActionError, Command } from "./types";

const MAX_ACTIVE_SESSIONS = 256;
const MAX_ACTIVE_COMMANDS_PER_SESSION = 512;
const CANCEL_RESERVE = 2;
const MAX_HISTORY_RECORDS = 16_384;
const HISTORY_RETENTION_MS = 10 * 60_000;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLIENT_COMMAND_ID = new RegExp(`^(${UUID})\\.${UUID}$`);

/** 原记录对象贯穿队列与结算，epoch 轮换不会替换仍在执行的命令身份。 */
export interface CommandRecord {
  readonly commandId: string;
  readonly rcsSessionId: string;
  readonly epoch: string;
  admitted: boolean;
  result: CommandRecordResult;
  expiresAt: number;
}

/** 历史结果与活动准入分离；unknown 只表示不可安全重放，并不持有活动额度。 */
export type CommandRecordResult =
  | { state: "in_flight"; ack: ActionAck }
  | { state: "committed"; ack: ActionAck }
  | { state: "failed"; error: ActionError }
  | { state: "unknown" };

/** 客户端 full ID 的结构校验与代次校验分开，使旧代在途记录仍可被精确查询。 */
export function readClientCommandEpoch(commandId: string): string | undefined {
  return CLIENT_COMMAND_ID.exec(commandId)?.[1];
}

/** 有界活动准入与重放证据；删除本代已接纳记录前先使本代外部命令失效。 */
export class CommandHistory {
  private epoch = randomUUID();
  private readonly active = new Map<string, Map<string, CommandRecord>>();
  private readonly history = new Map<string, CommandRecord>();
  private readonly epochListeners = new Set<(epoch: string) => void>();
  private nextExpiry = Number.POSITIVE_INFINITY;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduledExpiry = Number.POSITIVE_INFINITY;
  private maintaining = false;

  constructor(
    private readonly now: () => number,
    private readonly reportError?: (context: string, error: unknown) => void,
  ) {}

  /** 签发前先维护过期历史，保证新连接取得可用于新意图的当前代次。 */
  getEpoch(): string {
    this.pruneHistory();
    return this.epoch;
  }

  /** 轮换同步发布，调用方必须将新代次送达已认证连接或关闭连接。 */
  onEpochChanged(listener: (epoch: string) => void): () => void {
    this.epochListeners.add(listener);
    return () => this.epochListeners.delete(listener);
  }

  /** 优先查询仍在执行的 exact record，旧代在途不受历史轮换影响。 */
  find(rcsSessionId: string, commandId: string): CommandRecord | undefined {
    return this.active.get(rcsSessionId)?.get(commandId) ?? this.history.get(this.key(rcsSessionId, commandId));
  }

  /** 与外部 epoch 校验、新记录占位保持在调用方同一同步段内。 */
  prepareAdmission(): void {
    this.pruneHistory();
  }

  /** 只能在精确查询、维护与 epoch 校验的同一同步段内为新命令占位。 */
  admit(command: Command, ack: ActionAck): CommandRecord | undefined {
    const reserve = command.type === "cancel" ? CANCEL_RESERVE : 0;
    let session = this.active.get(command.rcsSessionId);
    if (!session && this.active.size >= MAX_ACTIVE_SESSIONS + reserve) return;
    if (session && session.size >= MAX_ACTIVE_COMMANDS_PER_SESSION + reserve) return;
    if (!session) {
      session = new Map();
      this.active.set(command.rcsSessionId, session);
    }
    const record: CommandRecord = {
      rcsSessionId: command.rcsSessionId,
      commandId: command.commandId,
      epoch: this.epoch,
      admitted: false,
      result: { state: "in_flight", ack },
      expiresAt: Number.POSITIVE_INFINITY,
    };
    session.set(command.commandId, record);
    return record;
  }

  /** 未进入 accepted 的验证失败不可能产生外部副作用，可直接归还占位。 */
  discard(record: CommandRecord): void {
    if (record.admitted) throw new Error("An accepted command requires a retained outcome");
    this.removeActive(record);
  }

  markUnknown(record: CommandRecord): void {
    if (this.active.get(record.rcsSessionId)?.get(record.commandId) === record) record.result = { state: "unknown" };
  }

  /** 外部执行器退场后只释放活动额度；结果仍在独立历史中阻止重放。 */
  settle(record: CommandRecord, result: CommandRecordResult): void {
    if (this.active.get(record.rcsSessionId)?.get(record.commandId) !== record) return;
    record.result = result;
    this.removeActive(record);
    record.expiresAt = this.now() + HISTORY_RETENTION_MS;
    this.nextExpiry = Math.min(this.nextExpiry, record.expiresAt);
    this.history.set(this.key(record.rcsSessionId, record.commandId), record);
    this.pruneHistory();
    this.scheduleExpiry();
  }

  private removeActive(record: CommandRecord): void {
    const session = this.active.get(record.rcsSessionId);
    if (session?.get(record.commandId) !== record) return;
    session.delete(record.commandId);
    if (session.size === 0) this.active.delete(record.rcsSessionId);
  }

  private pruneHistory(): void {
    if (this.maintaining) return;
    const now = this.now();
    const capacityReached = this.history.size >= MAX_HISTORY_RECORDS;
    if (!capacityReached && now < this.nextExpiry) return;
    this.maintaining = true;
    try {
      if (capacityReached) this.rotateEpoch();
      const target = Math.floor(MAX_HISTORY_RECORDS * 0.75);
      this.nextExpiry = Number.POSITIVE_INFINITY;
      for (const [key, record] of this.history) {
        if (record.expiresAt > now && (!capacityReached || this.history.size <= target)) {
          this.nextExpiry = Math.min(this.nextExpiry, record.expiresAt);
          continue;
        }
        if (record.epoch === this.epoch && record.admitted) this.rotateEpoch();
        this.history.delete(key);
      }
    } finally {
      this.maintaining = false;
      this.scheduleExpiry();
    }
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer && this.scheduledExpiry === this.nextExpiry) return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.scheduledExpiry = this.nextExpiry;
    if (!Number.isFinite(this.nextExpiry)) return;
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined;
        this.pruneHistory();
        this.scheduleExpiry();
      },
      Math.max(1, this.nextExpiry - this.now()),
    );
    this.expiryTimer.unref();
  }

  private rotateEpoch(): void {
    this.epoch = randomUUID();
    for (const listener of this.epochListeners) {
      try {
        listener(this.epoch);
      } catch (error) {
        try {
          this.reportError?.("[CommandHistory] command epoch publication failed", error);
        } catch {
          // 诊断 sink 故障不能阻断其他订阅者，尤其不能使后台到期维护抛回进程。
        }
      }
    }
  }

  private key(rcsSessionId: string, commandId: string): string {
    return JSON.stringify([rcsSessionId, commandId]);
  }
}
