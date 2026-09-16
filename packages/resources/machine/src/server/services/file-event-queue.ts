import { error as logError, warn as logWarn } from "@fenix/logger";

/**
 * 文件事件队列 — docs/arch/12-files.md §4.3 的新建异步事件队列。
 *
 * 与 `src/transport/event-bus.ts` 的 EventBus 无关（不得复用）：
 * EventBus 是同步回调、按 agentId/sessionId 隔离 ACP 会话事件；本队列是
 * 新建结构，按 environmentId 隔离文件变更事件（19 号文档不变量 5：禁全局广播）。
 *
 * 语义：
 * - 异步：`publishFileEvent` 只入队并同步返回，订阅者回调在微任务中执行，
 *   慢订阅者不阻塞 file-op 消息循环（fire-and-forget + try/catch）。
 * - 有界：每环境缓冲上限 FILE_EVENT_QUEUE_LIMIT（200）条；溢出时缓冲整体
 *   收敛为一条 invalidate_all 帧（丢弃带收敛，不静默丢），之后恢复正常缓冲。
 * - fan-out：同一环境一次入队、多路下发；每个订阅者独立调度，单个订阅者
 *   抛错或阻塞不影响其他订阅者。
 * - 生命周期：subscribe / registerEnvironmentQueue（机器声明）创建队列；
 *   无订阅且无机器声明时销毁（防 Map 泄漏）；destroyEnvironmentQueue 强制销毁。
 *
 * 限频与 batch 合并（20 条/s、batch ≤50）归 W7 的 file-event-limiter，本模块只做队列与 fan-out。
 */

/** 文件变更类型（§4.3 事件帧契约） */
export type FileChangeKind = "write" | "delete" | "mkdir" | "rename" | "upload";

/** 变更来源（契约先行审计字段，本期只定义不落库） */
export type FileChangeSource = "user" | "agent" | "api";

/** file_changed_batch 中的单条变更（增量语义，不是 invalidate_all） */
export interface FileBatchChange {
  path: string;
  kind: FileChangeKind;
  source: FileChangeSource;
  actor_id?: string;
}

/**
 * 发布侧输入帧：不含 environment_id，由队列按路由注入，发布方无需重复填写。
 * invalidate_all 不在此列，只能通过 `publishInvalidateAll` 发布。
 */
export type FileEventInput =
  | {
      type: "file_changed";
      path: string;
      kind: FileChangeKind;
      source: FileChangeSource;
      actor_id?: string;
      to?: string;
    }
  | {
      type: "file_changed_batch";
      changes: FileBatchChange[];
    }
  | {
      type: "degraded";
      machine_id: string;
      capability: "file";
      status: "down" | "recovered";
    };

/**
 * 订阅侧完整帧：路由字段已注入。degraded 为机器级帧（无 environment_id），
 * 仅按环境路由下发，帧内容原样透传。
 */
export type FileEventFrame =
  | {
      type: "file_changed";
      environment_id: string;
      path: string;
      kind: FileChangeKind;
      source: FileChangeSource;
      actor_id?: string;
      to?: string;
    }
  | {
      type: "file_changed_batch";
      environment_id: string;
      changes: FileBatchChange[];
    }
  | {
      type: "invalidate_all";
      environment_id: string;
    }
  | {
      type: "degraded";
      machine_id: string;
      capability: "file";
      status: "down" | "recovered";
    };

/** 订阅者回调：收到该环境的完整事件帧 */
export type FileEventSubscriber = (frame: FileEventFrame) => void;

/** 每环境事件缓冲上限；溢出收敛为 invalidate_all（env 化归 W4b 统一处理） */
const FILE_EVENT_QUEUE_LIMIT = 200;

interface FileEnvironmentQueue {
  envId: string;
  /** fan-out 目标集合 */
  subscribers: Set<FileEventSubscriber>;
  /** 机器声明标记：置位后无订阅者也不销毁，直到显式 destroyEnvironmentQueue */
  machineDeclared: boolean;
  /** 待 flush 的事件缓冲（有界 FILE_EVENT_QUEUE_LIMIT） */
  pending: FileEventFrame[];
  /** 已调度 flush 标志，避免同一 tick 内重复调度 */
  flushScheduled: boolean;
  /** 溢出收敛标志：置位期间后续事件被丢弃（已由 invalidate_all 收敛），flush 后复位 */
  overflowed: boolean;
}

/** 按 environmentId 隔离的环境队列表（模块级单例） */
const queues = new Map<string, FileEnvironmentQueue>();

function ensureQueue(envId: string): FileEnvironmentQueue {
  let queue = queues.get(envId);
  if (!queue) {
    queue = {
      envId,
      subscribers: new Set(),
      machineDeclared: false,
      pending: [],
      flushScheduled: false,
      overflowed: false,
    };
    queues.set(envId, queue);
  }
  return queue;
}

/** 无订阅且无机器声明时销毁队列，防止 Map 泄漏 */
function maybeDestroy(queue: FileEnvironmentQueue) {
  if (queue.subscribers.size === 0 && !queue.machineDeclared) {
    queues.delete(queue.envId);
  }
}

/** 入队并调度 flush；缓冲满时后续事件收敛为 invalidate_all（丢弃带收敛，不静默丢） */
function enqueue(queue: FileEnvironmentQueue, frame: FileEventFrame) {
  if (queue.pending.length >= FILE_EVENT_QUEUE_LIMIT) {
    // 溢出：已入队缓冲保留正常下发；后续事件不再逐条入队，收敛为一条
    // invalidate_all（合并去重，不重复发失效帧），订阅者据此全量重拉。
    // 收敛帧允许缓冲越界一条（201），flush 后恢复逐条模式。
    if (!queue.overflowed) {
      queue.overflowed = true;
      queue.pending.push({ type: "invalidate_all", environment_id: queue.envId });
      // 只在首次收敛时记录：溢出期间后续每个事件都会命中此分支，
      // 若逐条打日志会在突发（如机器重连事件风暴）时放大为日志风暴。
      logWarn(`[file-event-queue] environment ${queue.envId} overflow, converged to invalidate_all`);
    }
  } else {
    queue.pending.push(frame);
  }
  if (!queue.flushScheduled) {
    queue.flushScheduled = true;
    queueMicrotask(() => flush(queue));
  }
}

/** 取出缓冲并 fan-out；每个订阅者独立调度，异常与慢速互不牵连 */
function flush(queue: FileEnvironmentQueue) {
  queue.flushScheduled = false;
  queue.overflowed = false;
  const frames = queue.pending;
  queue.pending = [];
  if (queue.subscribers.size === 0) {
    // 无订阅者：事件直接丢弃（无订阅零开销）；无机器声明时销毁队列。
    maybeDestroy(queue);
    return;
  }
  for (const subscriber of queue.subscribers) {
    queueMicrotask(() => {
      for (const frame of frames) {
        try {
          subscriber(frame);
        } catch (err) {
          logError(`[file-event-queue] subscriber error for environment ${queue.envId}:`, err);
        }
      }
    });
  }
}

/** 输入帧转为完整帧：注入路由字段（degraded 为机器级帧，原样透传） */
function toFrame(envId: string, event: FileEventInput): FileEventFrame {
  if (event.type === "degraded") {
    return event;
  }
  return { ...event, environment_id: envId };
}

/**
 * 发布文件变更事件（file_changed / file_changed_batch / degraded）。
 *
 * 异步、不阻塞：本函数只入队并同步返回，订阅者回调在后续微任务中执行；
 * 队列溢出时事件被 invalidate_all 帧替代（见模块注释）。
 */
export function publishFileEvent(envId: string, event: FileEventInput): void {
  enqueue(ensureQueue(envId), toFrame(envId, event));
}

/**
 * 发布全量失效帧（invalidate_all）——仅用于未知范围（机器重连、path 未知的外部变更）。
 * 语义与入队逻辑同 publishFileEvent。
 */
export function publishInvalidateAll(envId: string): void {
  enqueue(ensureQueue(envId), { type: "invalidate_all", environment_id: envId });
}

/**
 * 订阅某环境的事件流。返回取消订阅函数；取消后若无订阅者且无机器声明，
 * 队列被销毁（防 Map 泄漏）。
 */
export function subscribe(envId: string, subscriber: FileEventSubscriber): () => void {
  const queue = ensureQueue(envId);
  queue.subscribers.add(subscriber);
  return () => {
    queue.subscribers.delete(subscriber);
    maybeDestroy(queue);
  };
}

/** 确保环境队列存在（供外部显式预创建；publish/subscribe 内部已隐式创建） */
export function ensure(envId: string): void {
  ensureQueue(envId);
}

/**
 * 登记机器声明的环境（机器注册 / 记账时调用）：置位后该环境队列在无订阅者时
 * 也保留，直到机器退役调用 destroyEnvironmentQueue。
 */
export function registerEnvironmentQueue(envId: string): void {
  ensureQueue(envId).machineDeclared = true;
}

/**
 * 销毁环境队列：清除订阅者与缓冲并从表移除。机器退役 / 环境删除时调用；
 * 无订阅且无机器声明的队列也会被 subscribe 取消时自动销毁。
 */
export function destroyEnvironmentQueue(envId: string): void {
  const queue = queues.get(envId);
  if (!queue) {
    return;
  }
  queue.subscribers.clear();
  queue.pending = [];
  queues.delete(envId);
}
