// packages/chat-channel/src/channel/command-coordinator.ts
// CommandCoordinator：Action 校验、commandId 幂等、命令串行化（每 rcsSessionId 有界队列）。
//
// 语义（PRD Q5/Q9，文档 7.1）：
// - accepted 仅表示进入有界队列；committed 表示业务事实已提交（含 committedProjectionVersion）。
// - full commandId 由服务端 epoch 与客户端 UUID 组成，结果在有界重试窗口内跨断线保留；
//   已提交命令重发返回原 Ack（status=duplicate），不重复调用 executeCommand。
// - 同一 rcsSessionId 的命令严格串行执行；队列有界，超出返回 RATE_LIMITED。
// - 已接纳命令的历史回收先轮换 epoch，避免未知外部副作用被遗忘重放。
//
// 本类不承载任何宿主业务（会话守卫 / Doc 写入 / relay 发送），全部通过依赖注入，
// 以便协议层测试 seam 用 fake 依赖实例化（Q12）。

import { createPublicError, type PublicError, type PublicErrorType, serializePublicErrorLog } from "../public-error";
import { CommandHistory, type CommandRecord, readClientCommandEpoch } from "./command-history";
import {
  type ActionAck,
  type ActionError,
  type ActionSinks,
  type Command,
  CommandExecutionError,
  type CommandOutcome,
  KNOWN_ACTION_TYPES,
  MAX_ACTION_PAYLOAD_BYTES,
} from "./types";

/** 每 rcsSessionId 有界队列默认上限（超出返回 RATE_LIMITED） */
const DEFAULT_MAX_PENDING_PER_SESSION = 64;
const CANCEL_RESERVE = 2;

export interface CommandCoordinatorDependencies {
  /** 串行执行命令（同一 rcsSessionId 内互不并发；恰好一次由去重表保证） */
  executeCommand: (command: Command, signal: AbortSignal) => Promise<CommandOutcome>;
  /** Action 上下文校验（会话存在/状态合法）；抛 CommandExecutionError 则拒绝且不发 accepted */
  validateAction?: (command: Command) => void | Promise<void>;
  /** 读取当前投影版本（VERSION_CONFLICT 校验与 committed ack 使用） */
  getProjectionVersion?: (rcsSessionId: string) => number | null;
  /** 每 rcsSessionId 队列上限，默认 64 */
  maxPendingPerSession?: number;
  /** 队列内 payload 总字节预算，默认 4 MiB。 */
  maxPendingBytesPerSession?: number;
  /** 去重保留窗口使用的时钟；默认 Date.now，测试可独立推进而不影响其他定时器。 */
  now?: () => number;
  /** 诊断日志（不得包含命令正文等敏感内容） */
  reportError?: (context: string, err: unknown) => void;
  /** 公开错误安全事件 sink；只接受 serializePublicErrorLog 的低敏 JSON。 */
  reportLog?: (message: string) => void;
}

interface QueueItem {
  command: Command;
  sinks: ActionSinks;
  resolve: () => void;
  bytes: number;
  record: CommandRecord;
}

interface SessionQueue {
  items: QueueItem[];
  running: boolean;
  abort: AbortController;
  pending: number;
  bytes: number;
  drained: Promise<void>;
  finish: () => void;
  predecessor?: Promise<void>;
  active?: QueueItem;
}

export class CommandCoordinator {
  private readonly history: CommandHistory;
  /** 每 rcsSessionId 有界串行队列 */
  private readonly queues = new Map<string, SessionQueue>();

  constructor(private readonly dependencies: CommandCoordinatorDependencies) {
    this.history = new CommandHistory(dependencies.now ?? Date.now, dependencies.reportError);
  }

  /** 服务端随机命令代次，客户端必须把它编码到 full commandId 中。 */
  getCommandEpoch(): string {
    return this.history.getEpoch();
  }

  /** 订阅命令历史轮换；旧在途记录继续按完整 ID 查询和结算。 */
  onCommandEpochChanged(listener: (epoch: string) => void): () => void {
    return this.history.onEpochChanged(listener);
  }

  /** 外部信封入口：旧代已遗失记录永远拒绝重新执行，不提供 raw-ID 回退。 */
  submitClientCommand(command: Command, sinks: ActionSinks): Promise<void> {
    return this.submitCommand(command, sinks, true);
  }

  /**
   * 可信内部领域入口；外部信封必须使用 submitClientCommand，禁止网络 raw-ID 回退。
   * 校验 → 幂等 → 入队（accepted）→ 串行执行（committed / error）。
   * 返回的 Promise 在命令处理完成（committed / error / duplicate）后 resolve，
   * 便于协议层测试直接 await 断言；生产路径可 fire-and-forget。
   */
  submit(command: Command, sinks: ActionSinks): Promise<void> {
    return this.submitCommand(command, sinks, false);
  }

  private submitCommand(command: Command, sinks: ActionSinks, client: boolean): Promise<void> {
    const shapeError = this.validateShape(command);
    if (shapeError) {
      sinks.sendError({ type: "action_error", commandId: command.commandId, error: this.publicError(shapeError) });
      return Promise.resolve();
    }

    const epoch = client ? readClientCommandEpoch(command.commandId) : undefined;
    if (client && !epoch) {
      sinks.sendError(this.toActionError(new CommandExecutionError("ACTION.INVALID_STATE"), command.commandId));
      return Promise.resolve();
    }
    // 精确查询、历史回收/换代、epoch 校验和新占位必须处于同一同步段。
    const existingRecord = this.history.find(command.rcsSessionId, command.commandId);
    if (existingRecord) {
      const existing = existingRecord.result;
      if (!existingRecord.admitted) {
        sinks.sendError(this.toActionError(new CommandExecutionError("ACTION.OUTCOME_UNKNOWN"), command.commandId));
      } else if (existing.state === "unknown") {
        sinks.sendError(this.toActionError(new CommandExecutionError("ACTION.OUTCOME_UNKNOWN"), command.commandId));
      } else if (existing.state === "committed") {
        sinks.sendAck(this.toDuplicateAck(existing.ack));
      } else if (existing.state === "failed") {
        sinks.sendError(existing.error);
      } else {
        sinks.sendAck(existing.ack);
      }
      return Promise.resolve();
    }
    this.history.prepareAdmission();
    if (client && epoch !== this.history.getEpoch()) {
      sinks.sendError(this.toActionError(new CommandExecutionError("ACTION.OUTCOME_UNKNOWN"), command.commandId));
      return Promise.resolve();
    }

    if (command.expectedProjectionVersion !== undefined) {
      const current = this.dependencies.getProjectionVersion?.(command.rcsSessionId) ?? null;
      if (current !== null && current !== command.expectedProjectionVersion) {
        sinks.sendError({
          type: "action_error",
          commandId: command.commandId,
          error: this.publicError("ACTION.VERSION_CONFLICT"),
        });
        return Promise.resolve();
      }
    }

    const accepted: ActionAck = { type: "action_ack", commandId: command.commandId, status: "accepted" };
    const record = this.history.admit(command, accepted);
    if (!record) {
      sinks.sendError(this.toActionError(new CommandExecutionError("ACTION.RATE_LIMITED"), command.commandId));
      return Promise.resolve();
    }
    return this.enqueue(command, sinks, accepted, record);
  }

  /** 关闭旧队列；重连等待旧执行器退场，已发送或完成命令保留有界去重。 */
  disposeRcsSession(rcsSessionId: string): void {
    const queue = this.queues.get(rcsSessionId);
    if (!queue) return;
    if (queue.active) this.history.markUnknown(queue.active.record);
    queue.abort.abort();
    for (const item of queue.items.splice(0)) {
      const error = this.toActionError(new CommandExecutionError("ACTION.SESSION_NOT_FOUND"), item.command.commandId);
      this.history.settle(item.record, { state: "failed", error });
      item.sinks.sendError(error);
      queue.pending--;
      queue.bytes -= item.bytes;
      item.resolve();
    }
    if (queue.pending === 0) void this.processNext(rcsSessionId, queue);
  }

  private async enqueue(
    command: Command,
    sinks: ActionSinks,
    accepted: ActionAck,
    record: CommandRecord,
  ): Promise<void> {
    const queue = this.getQueue(command.rcsSessionId);
    const bytes = new TextEncoder().encode(JSON.stringify(command.payload)).byteLength;
    const reserved = command.type === "cancel" ? CANCEL_RESERVE : 0;
    if (
      queue.pending >= (this.dependencies.maxPendingPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION) + 1 + reserved ||
      queue.bytes + bytes > (this.dependencies.maxPendingBytesPerSession ?? 4 * 1024 * 1024) + reserved * 1024
    ) {
      this.history.discard(record);
      sinks.sendError(this.toActionError(new CommandExecutionError("ACTION.RATE_LIMITED"), command.commandId));
      if (queue.pending === 0) void this.processNext(command.rcsSessionId, queue);
      return;
    }
    queue.pending++;
    queue.bytes += bytes;
    try {
      await this.dependencies.validateAction?.(command);
      if (queue.abort.signal.aborted) throw new CommandExecutionError("ACTION.SESSION_NOT_FOUND");
    } catch (err) {
      queue.pending--;
      queue.bytes -= bytes;
      this.history.discard(record);
      sinks.sendError(this.toActionError(err, command.commandId));
      if (queue.pending === 0) void this.processNext(command.rcsSessionId, queue);
      return;
    }
    return new Promise<void>((resolve) => {
      const item = { command, sinks, resolve, bytes, record };
      if (command.type === "cancel") queue.items.unshift(item);
      else queue.items.push(item);
      record.admitted = true;
      sinks.sendAck(accepted);
      void this.processNext(command.rcsSessionId, queue);
    });
  }

  private async processNext(rcsSessionId: string, queue: SessionQueue): Promise<void> {
    if (queue.running) return;
    queue.running = true;
    try {
      if (queue.predecessor) await queue.predecessor;
      while (!queue.abort.signal.aborted && queue.items.length > 0) {
        const item = queue.items.shift();
        if (!item) break;
        queue.active = item;
        await this.runCommand(rcsSessionId, item, queue.abort.signal);
        queue.active = undefined;
        queue.pending--;
        queue.bytes -= item.bytes;
      }
    } finally {
      queue.running = false;
      // 异步验证同样持有串行屏障，只有全部验证与执行都退场才释放队列。
      if (queue.pending === 0) {
        queue.finish();
        if (this.queues.get(rcsSessionId) === queue) this.queues.delete(rcsSessionId);
      }
    }
  }

  private async runCommand(rcsSessionId: string, item: QueueItem, signal: AbortSignal): Promise<void> {
    const { command, sinks } = item;
    try {
      const outcome = await this.dependencies.executeCommand(command, signal);
      const version = this.dependencies.getProjectionVersion?.(rcsSessionId) ?? null;
      const committed: ActionAck = {
        type: "action_ack",
        commandId: command.commandId,
        status: "committed",
        ...(outcome.turnId ? { turnId: outcome.turnId } : {}),
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
        ...(version !== null ? { committedProjectionVersion: version } : {}),
      };
      this.history.settle(item.record, { state: "committed", ack: committed });
      if (!signal.aborted) sinks.sendAck(committed);
    } catch (err) {
      // 断线后无法确定已发送副作用，保留去重记录阻止重连盲目重放。
      const error = this.toActionError(err, command.commandId);
      this.history.settle(item.record, signal.aborted ? { state: "unknown" } : { state: "failed", error });
      if (!signal.aborted) sinks.sendError(error);
    } finally {
      item.resolve();
    }
  }

  private validateShape(command: Command): PublicErrorType | null {
    if (typeof command.commandId !== "string" || command.commandId.length === 0 || command.commandId.length > 128)
      return "ACTION.INVALID_STATE";
    if (!KNOWN_ACTION_TYPES.includes(command.type as (typeof KNOWN_ACTION_TYPES)[number]))
      return "ACTION.INVALID_STATE";
    if (!command.payload || typeof command.payload !== "object") return "ACTION.INVALID_STATE";
    if (new TextEncoder().encode(JSON.stringify(command.payload)).byteLength > MAX_ACTION_PAYLOAD_BYTES)
      return "ACTION.PAYLOAD_TOO_LARGE";
    return null;
  }

  private toActionError(err: unknown, commandId: string): ActionError {
    const type = err instanceof CommandExecutionError ? err.publicErrorType : "INTERNAL.UNCLASSIFIED";
    if (!(err instanceof CommandExecutionError)) {
      this.dependencies.reportError?.("[CommandCoordinator] unexpected command failure", typeof err);
    }
    return { type: "action_error", commandId, error: this.publicError(type) };
  }

  private publicError(type: PublicErrorType): PublicError {
    const error = createPublicError(type);
    this.dependencies.reportLog?.(serializePublicErrorLog(error, "action.command"));
    return error;
  }

  private toDuplicateAck(original: ActionAck): ActionAck {
    return {
      type: "action_ack",
      commandId: original.commandId,
      status: "duplicate",
      ...(original.turnId ? { turnId: original.turnId } : {}),
      ...(original.sessionId ? { sessionId: original.sessionId } : {}),
      ...(original.committedProjectionVersion !== undefined
        ? { committedProjectionVersion: original.committedProjectionVersion }
        : {}),
    };
  }

  private getQueue(rcsSessionId: string): SessionQueue {
    let queue = this.queues.get(rcsSessionId);
    if (!queue || queue.abort.signal.aborted) {
      const predecessor = queue?.drained;
      let finish = () => {};
      const drained = new Promise<void>((resolve) => {
        finish = resolve;
      });
      queue = {
        items: [],
        running: false,
        abort: new AbortController(),
        pending: 0,
        bytes: 0,
        drained,
        finish,
        predecessor,
      };
      this.queues.set(rcsSessionId, queue);
    }
    return queue;
  }
}
