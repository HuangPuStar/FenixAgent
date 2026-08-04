/**
 * AgentNodeService：AgentNode 的生命周期管理。
 *
 * 职责：
 *   - 被动接收 Machine 连接（handleIncomingConnection）并生成 / 复用 AgentNode
 *   - ensureNode / releaseNode 维护引用计数；节点不存在或未处于 connected 状态时
 *     ensureNode 抛 {@link AgentNodeUnavailableError}
 *   - 引用计数归零后启动空闲超时回收；仅对已断连（非 connected）节点执行关闭，
 *     机器在线节点保留以复用（关闭 connected 节点会切断机器真实 WS，见 E-P1.1），
 *     新引用到达时取消
 *   - 节点进入 closed 终态后移出管理集合，允许后续新连接重建节点
 */

import { AgentNodeUnavailableError } from "../errors";
import type { AgentNodeStatus } from "../types/domain";
import { AgentNode } from "./agent-node";
import {
  type AgentNodeOptions,
  type AgentNodeServiceConfig,
  type AgentNodeSocket,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_SCHEDULER,
  type TimerScheduler,
} from "./types";

/** AgentNode 生命周期管理服务。 */
export class AgentNodeService {
  readonly #nodes = new Map<string, AgentNode>();
  readonly #refCounts = new Map<string, number>();
  readonly #idleTimers = new Map<string, unknown>();
  readonly #idleTimeoutMs: number;
  readonly #maxRetries: number;
  readonly #reconnectDelayMs: number;
  readonly #connectTimeoutMs: number;
  readonly #scheduler: TimerScheduler;

  constructor(config: AgentNodeServiceConfig) {
    this.#idleTimeoutMs = config.idleTimeoutMs;
    this.#maxRetries = config.maxRetries;
    this.#reconnectDelayMs = config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#scheduler = config.scheduler ?? DEFAULT_SCHEDULER;
  }

  /**
   * 被动连接：Machine 连接到达时生成 AgentNode，同 machineId 已存在可用节点时复用
   * （替换 WS 信道并同步为 connected），已关闭 / 关闭中的节点则重建。
   */
  handleIncomingConnection(machineId: string, socket: AgentNodeSocket): AgentNode {
    const existing = this.#nodes.get(machineId);
    if (existing !== undefined && this.#isUsable(existing)) {
      existing._attachSocket(socket);
      existing._handleConnected();
      return existing;
    }
    if (existing !== undefined) {
      // 旧节点不可用（关闭中/已关闭）：先移出管理集合，避免与新节点并存
      this.#removeNode(machineId);
    }
    const node = this.#createNode(machineId, socket);
    node._handleConnected(); // 被动连接到达即视为已打开
    this.#nodes.set(machineId, node);
    // 无实例引用（连接后从未 ensureNode，或引用已归零）时启动空闲回收：
    // 机器连接但没有实例承载的节点在机器在线期间应保留复用；空闲回收仅针对
    // 已断连节点（断连后由 WS 事件 / onAutoReconnectStopped 驱动回收）。
    // ensureNode 到达时 #cancelIdleTimer 会取消，不干扰正常引用生命周期。
    if (!this.#refCounts.has(machineId)) {
      this.#startIdleTimer(machineId);
    }
    return node;
  }

  /**
   * 获取 AgentNode（引用计数 +1），并取消该节点的空闲回收定时器。
   * @throws AgentNodeUnavailableError 节点不存在或未处于 connected 状态
   */
  ensureNode(machineId: string): AgentNode {
    const node = this.#nodes.get(machineId);
    if (node === undefined) {
      throw new AgentNodeUnavailableError("Agent node is unavailable (not connected)");
    }
    const status = node.status();
    // 仅 connected 节点可承载新实例。disconnected / connecting / uninitialized 表示机器
    // 断连或重连未完成：放行会走死信道（core 侧 NODE_OFFLINE 500 或长时间超时），
    // 与设计文档「spawn 时 machine 未连接 → AGENT_NODE_UNAVAILABLE (503)」对齐。
    // message 不得包含 machineId：message 会经 errorPlugin 原样进入响应体。
    if (status !== "connected") {
      throw new AgentNodeUnavailableError(`Agent node is unavailable (status: ${status})`);
    }
    this.#cancelIdleTimer(machineId);
    this.#refCounts.set(machineId, (this.#refCounts.get(machineId) ?? 0) + 1);
    return node;
  }

  /**
   * Instance 归还引用（计数 -1）；计数归零后启动空闲超时回收，
   * 超时后已断连节点被关闭并从管理集合移除（机器在线节点保留，见 #startIdleTimer）。
   * @throws AgentNodeUnavailableError 节点未被管理
   */
  releaseNode(machineId: string): void {
    if (!this.#nodes.has(machineId)) {
      throw new AgentNodeUnavailableError(`Agent node for machine ${machineId} is not managed`);
    }
    const next = (this.#refCounts.get(machineId) ?? 1) - 1;
    if (next <= 0) {
      this.#refCounts.delete(machineId);
      this.#startIdleTimer(machineId);
    } else {
      this.#refCounts.set(machineId, next);
    }
  }

  /** 当前管理的 AgentNode 数（已关闭节点会自动移出）。 */
  activeCount(): number {
    return this.#nodes.size;
  }

  // ---- 私有 ----

  /** 节点是否可被复用：未进入关闭流程且未到终态。 */
  #isUsable(node: AgentNode): boolean {
    const status = node.status();
    return status !== "closing" && status !== "closed" && status !== "destroyed";
  }

  #createNode(machineId: string, socket: AgentNodeSocket): AgentNode {
    let node: AgentNode | undefined;
    const created = new AgentNode(
      this.#nodeOptions(machineId, socket, (status) => {
        // 仅当 map 中仍持有本节点时才移除，避免误删已被新节点替换的旧节点
        if (status === "closed" && node !== undefined && this.#nodes.get(machineId) === node) {
          this.#removeNode(machineId);
        }
      }),
    );
    node = created;
    return created;
  }

  #nodeOptions(
    machineId: string,
    socket: AgentNodeSocket,
    onStatusChange: (status: AgentNodeStatus, previous: AgentNodeStatus) => void,
  ): AgentNodeOptions {
    return {
      machineId,
      socket,
      connectTimeoutMs: this.#connectTimeoutMs,
      maxRetries: this.#maxRetries,
      reconnectDelayMs: this.#reconnectDelayMs,
      scheduler: this.#scheduler,
      onStatusChange,
      // 自动重连停止（耗尽或重连失败）且无实例引用时直接关闭节点（uninitialized /
      // disconnected 态下 close 不触碰底层 WS，只推进 FSM 到 closed），由
      // onStatusChange 的 closed 分支移出管理集合；有引用时保留节点，等待引用
      // 归零后的正常空闲回收。
      onAutoReconnectStopped: () => {
        const refCount = this.#refCounts.get(machineId) ?? 0;
        const node = this.#nodes.get(machineId);
        if (refCount === 0 && node !== undefined) {
          node.close();
        }
      },
    };
  }

  /** 启动空闲回收定时器：超时后仅回收已断连节点；机器在线（connected）节点保留。 */
  #startIdleTimer(machineId: string): void {
    this.#cancelIdleTimer(machineId);
    const handle = this.#scheduler.setTimeout(() => {
      this.#idleTimers.delete(machineId);
      const node = this.#nodes.get(machineId);
      if (node === undefined) return;
      // 机器仍在线（connected）时保留节点：节点生命周期应跟随机器 WS（断连 →
      // 自动重连耗尽 → onAutoReconnectStopped 回收），实例引用归零不等于机器下线。
      // 关闭 connected 节点会经 AgentNode.close() 的 connected 分支触发 socket.close()，
      // 关闭机器与宿主的唯一真实 WS 信道，造成每 idleTimeoutMs 一次的断连-重连风暴
      // （E-P1.1）。这里只回收已断连节点，且不重启定时器——connected 节点的后续
      // 生命周期由 WS 事件驱动。
      if (node.status() === "connected") return;
      node.close();
    }, this.#idleTimeoutMs);
    this.#idleTimers.set(machineId, handle);
  }

  /** 取消空闲回收定时器（新引用到达或节点移除时）。 */
  #cancelIdleTimer(machineId: string): void {
    const handle = this.#idleTimers.get(machineId);
    if (handle !== undefined) {
      this.#scheduler.clearTimeout(handle);
      this.#idleTimers.delete(machineId);
    }
  }

  /** 节点关闭后清理全部关联状态。 */
  #removeNode(machineId: string): void {
    this.#nodes.delete(machineId);
    this.#refCounts.delete(machineId);
    this.#cancelIdleTimer(machineId);
  }
}
