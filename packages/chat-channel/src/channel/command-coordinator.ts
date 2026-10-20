// packages/chat-channel/src/channel/command-coordinator.ts
// CommandCoordinator：Action 校验、commandId 幂等、命令串行化（每 rcsSessionId 有界队列）。
//
// 语义（PRD Q5/Q9，文档 7.1）：
// - accepted 仅表示进入有界队列；committed 表示业务事实已提交（含 committedProjectionVersion）。
// - commandId 去重表按 rcsSessionId 划分，在有界重试窗口内跨断线保留；
//   已提交命令重发返回原 Ack（status=duplicate），不重复调用 executeCommand。
// - 同一 rcsSessionId 的命令严格串行执行；队列有界，超出返回 RATE_LIMITED。
// - 执行失败清除去重记录：重发允许重新执行（失败不视为副作用已发生）。
//
// 本类不承载任何宿主业务（会话守卫 / Doc 写入 / relay 发送），全部通过依赖注入，
// 以便协议层测试 seam 用 fake 依赖实例化（Q12）。

import { createPublicError, type PublicError, type PublicErrorType, serializePublicErrorLog } from "../public-error";
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
/** 队列满时的建议重试间隔（毫秒） */

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
}

/** 去重记录：in_flight 期间重发返回原 accepted；committed 后重发返回 duplicate */
type DedupRecord =
  | { state: "in_flight"; ack: ActionAck }
  | { state: "committed"; ack: ActionAck }
  | { state: "unknown" };

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
  /** 每 rcsSessionId 去重表：commandId → 确认结果或不确定状态（10 分钟窗口） */
  private readonly dedup = new Map<string, Map<string, DedupRecord>>();
  /** 每 rcsSessionId 有界串行队列 */
  private readonly queues = new Map<string, SessionQueue>();
  private readonly dedupExpiry = new Map<string, number>();

  constructor(private readonly dependencies: CommandCoordinatorDependencies) {}

  /**
   * 提交一个命令：校验 → 幂等 → 入队（accepted）→ 串行执行（committed / error）。
   * 返回的 Promise 在命令处理完成（committed / error / duplicate）后 resolve，
   * 便于协议层测试直接 await 断言；生产路径可 fire-and-forget。
   */
  submit(command: Command, sinks: ActionSinks): Promise<void> {
    const shapeError = this.validateShape(command);
    if (shapeError) {
      sinks.sendError({ type: "action_error", commandId: command.commandId, error: this.publicError(shapeError) });
      return Promise.resolve();
    }

    // 幂等检查与 in_flight 标记必须在同一同步段完成（Bun 单线程事件循环），
    // 保证并发重发不会绕过去重表导致 executeCommand 被调用两次。
    this.pruneDedup();
    const existing = this.dedup.get(command.rcsSessionId)?.get(command.commandId);
    if (existing) {
      if (existing.state === "unknown") {
        sinks.sendError(this.toActionError(new CommandExecutionError("ACTION.OUTCOME_UNKNOWN"), command.commandId));
      } else if (existing.state === "committed") {
        sinks.sendAck(this.toDuplicateAck(existing.ack));
      } else {
        sinks.sendAck(existing.ack);
      }
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

    if (!this.dedup.has(command.rcsSessionId) && this.dedup.size >= 256) {
      sinks.sendError(this.toActionError(new CommandExecutionError("ACTION.RATE_LIMITED"), command.commandId));
      return Promise.resolve();
    }
    const dedupTable = this.getDedupTable(command.rcsSessionId);
    if (dedupTable.size >= 512) {
      sinks.sendError({
        type: "action_error",
        commandId: command.commandId,
        error: this.publicError("ACTION.RATE_LIMITED"),
      });
      return Promise.resolve();
    }
    this.dedupExpiry.set(command.rcsSessionId, Date.now() + 10 * 60_000);
    const accepted: ActionAck = { type: "action_ack", commandId: command.commandId, status: "accepted" };
    dedupTable.set(command.commandId, { state: "in_flight", ack: accepted });

    return this.enqueue(command, sinks, accepted);
  }

  /** 关闭旧队列；重连等待旧执行器退场，已发送或完成命令保留有界去重。 */
  disposeRcsSession(rcsSessionId: string): void {
    const queue = this.queues.get(rcsSessionId);
    if (!queue) return;
    if (queue.active) this.getDedupTable(rcsSessionId).set(queue.active.command.commandId, { state: "unknown" });
    queue.abort.abort();
    for (const item of queue.items.splice(0)) {
      this.clearDedup(rcsSessionId, item.command.commandId);
      item.sinks.sendError(
        this.toActionError(new CommandExecutionError("ACTION.SESSION_NOT_FOUND"), item.command.commandId),
      );
      item.resolve();
    }
    if (!queue.running) queue.finish();
  }

  private async enqueue(command: Command, sinks: ActionSinks, accepted: ActionAck): Promise<void> {
    const queue = this.getQueue(command.rcsSessionId);
    const bytes = new TextEncoder().encode(JSON.stringify(command.payload)).byteLength;
    const reserved = command.type === "cancel" ? 2 : 0;
    if (
      queue.pending >= (this.dependencies.maxPendingPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION) + 1 + reserved ||
      queue.bytes + bytes > (this.dependencies.maxPendingBytesPerSession ?? 4 * 1024 * 1024) + reserved * 1024
    ) {
      this.clearDedup(command.rcsSessionId, command.commandId);
      sinks.sendError(this.toActionError(new CommandExecutionError("ACTION.RATE_LIMITED"), command.commandId));
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
      this.clearDedup(command.rcsSessionId, command.commandId);
      sinks.sendError(this.toActionError(err, command.commandId));
      return;
    }
    return new Promise<void>((resolve) => {
      const item = { command, sinks, resolve, bytes };
      if (command.type === "cancel") queue.items.unshift(item);
      else queue.items.push(item);
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
      queue.finish();
      if (this.queues.get(rcsSessionId) === queue && !queue.abort.signal.aborted) this.queues.delete(rcsSessionId);
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
      this.recordCommitted(rcsSessionId, command.commandId, committed);
      if (!signal.aborted) sinks.sendAck(committed);
    } catch (err) {
      // 断线后无法确定已发送副作用，保留去重记录阻止重连盲目重放。
      if (signal.aborted) this.getDedupTable(rcsSessionId).set(command.commandId, { state: "unknown" });
      else this.clearDedup(rcsSessionId, command.commandId);
      if (!signal.aborted) sinks.sendError(this.toActionError(err, command.commandId));
    } finally {
      item.resolve();
    }
  }

  private pruneDedup(): void {
    for (const [id, expiry] of this.dedupExpiry) {
      if (expiry > Date.now()) continue;
      if (this.queues.get(id)?.running) continue;
      this.dedup.delete(id);
      this.dedupExpiry.delete(id);
      if (this.queues.get(id)?.abort.signal.aborted) this.queues.delete(id);
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

  private getDedupTable(rcsSessionId: string): Map<string, DedupRecord> {
    let table = this.dedup.get(rcsSessionId);
    if (!table) {
      table = new Map();
      this.dedup.set(rcsSessionId, table);
    }
    return table;
  }

  private recordCommitted(rcsSessionId: string, commandId: string, ack: ActionAck): void {
    this.getDedupTable(rcsSessionId).set(commandId, { state: "committed", ack });
  }

  private clearDedup(rcsSessionId: string, commandId: string): void {
    this.getDedupTable(rcsSessionId).delete(commandId);
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
