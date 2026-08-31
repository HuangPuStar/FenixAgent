// packages/chat-channel/src/channel/command-coordinator.ts
// CommandCoordinator：Action 校验、commandId 幂等、命令串行化（每 rcsSessionId 有界队列）。
//
// 语义（PRD Q5/Q9，文档 7.1）：
// - accepted 仅表示进入有界队列；committed 表示业务事实已提交（含 committedProjectionVersion）。
// - commandId 去重表按 rcsSessionId 划分、随实例生命周期释放（disposeRcsSession）；
//   已提交命令重发返回原 Ack（status=duplicate），不重复调用 executeCommand。
// - 同一 rcsSessionId 的命令严格串行执行；队列有界，超出返回 RATE_LIMITED。
// - 执行失败清除去重记录：重发允许重新执行（失败不视为副作用已发生）。
//
// 本类不承载任何宿主业务（会话守卫 / Doc 写入 / relay 发送），全部通过依赖注入，
// 以便协议层测试 seam 用 fake 依赖实例化（Q12）。

import { createPublicError, type PublicError, type PublicErrorType } from "../public-error";
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
  executeCommand: (command: Command) => Promise<CommandOutcome>;
  /** Action 上下文校验（会话存在/状态合法）；抛 CommandExecutionError 则拒绝且不发 accepted */
  validateAction?: (command: Command) => void | Promise<void>;
  /** 读取当前投影版本（VERSION_CONFLICT 校验与 committed ack 使用） */
  getProjectionVersion?: (rcsSessionId: string) => number | null;
  /** 每 rcsSessionId 队列上限，默认 64 */
  maxPendingPerSession?: number;
  /** 诊断日志（不得包含命令正文等敏感内容） */
  reportError?: (context: string, err: unknown) => void;
}

interface QueueItem {
  command: Command;
  sinks: ActionSinks;
  resolve: () => void;
}

/** 去重记录：in_flight 期间重发返回原 accepted；committed 后重发返回 duplicate */
type DedupRecord = { state: "in_flight"; ack: ActionAck } | { state: "committed"; ack: ActionAck };

interface SessionQueue {
  items: QueueItem[];
  running: boolean;
}

export class CommandCoordinator {
  /** 每 rcsSessionId 去重表：commandId → ack 结果（随实例生命周期释放） */
  private readonly dedup = new Map<string, Map<string, DedupRecord>>();
  /** 每 rcsSessionId 有界串行队列 */
  private readonly queues = new Map<string, SessionQueue>();

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

    // 幂等检查与 in_flight 标记必须在同一同步段完成（Bun 单线程事件循环），
    // 保证并发重发不会绕过去重表导致 executeCommand 被调用两次。
    const dedupTable = this.getDedupTable(command.rcsSessionId);
    const existing = dedupTable.get(command.commandId);
    if (existing) {
      if (existing.state === "committed") {
        sinks.sendAck(this.toDuplicateAck(existing.ack));
      } else {
        sinks.sendAck(existing.ack);
      }
      return Promise.resolve();
    }

    const accepted: ActionAck = { type: "action_ack", commandId: command.commandId, status: "accepted" };
    dedupTable.set(command.commandId, { state: "in_flight", ack: accepted });

    return this.enqueue(command, sinks, accepted);
  }

  /** 释放 rcsSessionId 的去重表与队列（实例回收 / 断链清理时调用） */
  disposeRcsSession(rcsSessionId: string): void {
    this.dedup.delete(rcsSessionId);
    this.queues.delete(rcsSessionId);
  }

  // ── 内部 ──

  private async enqueue(command: Command, sinks: ActionSinks, accepted: ActionAck): Promise<void> {
    // validateAction 可能异步（如查库）；await 前 in_flight 已标记，
    // 期间重发的命令会在 submit 的幂等检查中命中并返回原 accepted。
    try {
      await this.dependencies.validateAction?.(command);
    } catch (err) {
      this.clearDedup(command.rcsSessionId, command.commandId);
      sinks.sendError(this.toActionError(err, command.commandId));
      return;
    }

    const queue = this.getQueue(command.rcsSessionId);
    if (queue.items.length >= (this.dependencies.maxPendingPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION)) {
      this.clearDedup(command.rcsSessionId, command.commandId);
      sinks.sendError({
        type: "action_error",
        commandId: command.commandId,
        error: this.publicError("ACTION.RATE_LIMITED"),
      });
      return;
    }

    queue.items.push({
      command,
      sinks,
      resolve: () => {},
    });

    return new Promise<void>((resolve) => {
      const item = queue.items[queue.items.length - 1];
      item.resolve = resolve;
      sinks.sendAck(accepted);
      void this.processNext(command.rcsSessionId);
    });
  }

  private async processNext(rcsSessionId: string): Promise<void> {
    const queue = this.queues.get(rcsSessionId);
    if (!queue || queue.running) return;
    queue.running = true;
    try {
      while (queue.items.length > 0) {
        const item = queue.items.shift();
        if (!item) break;
        await this.runCommand(rcsSessionId, item);
      }
    } finally {
      queue.running = false;
      // 处理期间新入队的命令由新一轮 processNext 接管（while 已空时才会走到这里）
      if (queue.items.length > 0) {
        void this.processNext(rcsSessionId);
      } else {
        this.queues.delete(rcsSessionId);
      }
    }
  }

  private async runCommand(rcsSessionId: string, item: QueueItem): Promise<void> {
    const { command, sinks } = item;
    try {
      const outcome = await this.dependencies.executeCommand(command);
      const version = this.dependencies.getProjectionVersion?.(rcsSessionId) ?? null;
      const committed: ActionAck = {
        type: "action_ack",
        commandId: command.commandId,
        status: "committed",
        ...(outcome.turnId ? { turnId: outcome.turnId } : {}),
        ...(version !== null ? { committedProjectionVersion: version } : {}),
      };
      this.recordCommitted(rcsSessionId, command.commandId, committed);
      sinks.sendAck(committed);
    } catch (err) {
      // 失败清除 in_flight：重发视为新执行（副作用未发生），客户端可安全重试
      this.clearDedup(rcsSessionId, command.commandId);
      sinks.sendError(this.toActionError(err, command.commandId));
    } finally {
      item.resolve();
    }
  }

  private validateShape(command: Command): PublicErrorType | null {
    if (typeof command.commandId !== "string" || command.commandId.length === 0) return "ACTION.INVALID_STATE";
    if (!KNOWN_ACTION_TYPES.includes(command.type as (typeof KNOWN_ACTION_TYPES)[number]))
      return "ACTION.INVALID_STATE";
    if (!command.payload || typeof command.payload !== "object") return "ACTION.INVALID_STATE";
    if (JSON.stringify(command.payload).length > MAX_ACTION_PAYLOAD_BYTES) return "ACTION.PAYLOAD_TOO_LARGE";
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
    this.dependencies.reportError?.("[ChatError] public action failure", {
      event: "chat.error",
      errorId: error.id,
      errorType: error.type,
      stage: "action.command",
      occurredAt: new Date().toISOString(),
    });
    return error;
  }

  private toDuplicateAck(original: ActionAck): ActionAck {
    return {
      type: "action_ack",
      commandId: original.commandId,
      status: "duplicate",
      ...(original.turnId ? { turnId: original.turnId } : {}),
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
    if (!queue) {
      queue = { items: [], running: false };
      this.queues.set(rcsSessionId, queue);
    }
    return queue;
  }
}
