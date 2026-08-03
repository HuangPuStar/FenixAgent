/**
 * AgentNode：远端 Machine 在本侧的连接生命周期管理类。
 *
 * 职责：
 *   - 持有 WS 信道（{@link AgentNodeSocket} 抽象，不依赖具体 ws 库）
 *   - 维护 FSM 状态：uninitialized → connecting → connected，意外断连进入
 *     disconnected 并由内部定时器自动重连（对象不销毁），主动关闭走 closing → closed
 *   - 提供 send / close / status，以及供 AgentNodeService 驱动的内部钩子
 *
 * 关键规则：仅 connected 状态下 send 合法，其余状态抛
 * {@link AgentNodeUnavailableError}；close() 在终态幂等。
 */

import { randomUUID } from "node:crypto";
import { AgentNodeUnavailableError } from "../errors";
import { Instance } from "../instance/instance";
import type { LaunchSpec } from "../launch-spec/types";
import type { AgentNodeStatus } from "../types/domain";
import type { AgentNodeEvent } from "./agent-node-fsm";
import { AgentNodeFsm } from "./agent-node-fsm";
import {
  type AgentNodeOptions,
  type AgentNodeSocket,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_SCHEDULER,
  type TimerScheduler,
} from "./types";

/** AgentNode 生命周期管理类。 */
export class AgentNode {
  /** 远端机器标识。 */
  readonly machineId: string;

  #fsm = new AgentNodeFsm();
  #socket: AgentNodeSocket | null = null;
  #connectTimeoutMs: number;
  #maxRetries: number;
  #reconnectDelayMs: number;
  #scheduler: TimerScheduler;
  #onStatusChange?: (status: AgentNodeStatus, previous: AgentNodeStatus) => void;
  #onAutoReconnectStopped?: () => void;
  #reconnectTimer: unknown = null;
  #connectTimer: unknown = null;
  #retryCount = 0;

  constructor(options: AgentNodeOptions) {
    this.machineId = options.machineId;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? 0;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#onStatusChange = options.onStatusChange;
    this.#onAutoReconnectStopped = options.onAutoReconnectStopped;
    this._attachSocket(options.socket);
  }

  /** 懒查询当前生命周期状态（每次读取实时值）。 */
  status(): AgentNodeStatus {
    return this.#fsm.getStatus();
  }

  /** 通过 WS 发送数据；仅 connected 状态合法，否则抛 AgentNodeUnavailableError。 */
  send(data: unknown): void {
    if (this.status() !== "connected" || this.#socket === null) {
      throw new AgentNodeUnavailableError(`Agent node ${this.machineId} is not connected (status: ${this.status()})`);
    }
    this.#socket.send(data);
  }

  /**
   * 主动关闭：进入 closing；有活跃连接时调用 socket.close() 等待 close 确认
   * （由 _handleDisconnected 完成 closeConfirmed），无活跃连接时直接确认 closed。
   * 终态（closed / destroyed）与 closing 中间态下幂等返回（closing 时 WS 确认
   * 事件尚未到达，重复调用不应触发 FSM 非法转换）。
   */
  close(): void {
    const status = this.status();
    if (status === "closing" || status === "closed" || status === "destroyed") {
      return;
    }
    this.#transition("closeRequested");
    this.#clearConnectTimer();
    this.#clearReconnectTimer();
    if (status === "connected") {
      // 等待 socket close 事件确认（_handleDisconnected 中推进 closeConfirmed）
      this.#socket?.close();
    } else {
      // uninitialized / connecting / disconnected：无活跃连接，无需等待确认
      this.#transition("closeConfirmed");
    }
  }

  // ---- 内部钩子（由 AgentNodeService 或 socket 事件驱动，不属于公开 API） ----

  /** WS open 回调：推进到 connected；connected 幂等，关闭竞态 / 终态忽略。 */
  _handleConnected(): void {
    switch (this.status()) {
      case "connected":
        return; // 幂等
      case "closing":
      case "closed":
      case "destroyed":
        return; // 关闭竞态 / 终态
      case "uninitialized":
      case "disconnected":
        this.#transition("connect");
        break;
      case "connecting":
        break;
    }
    this.#transition("open");
    this.#retryCount = 0;
    this.#clearConnectTimer();
    this.#clearReconnectTimer();
  }

  /**
   * WS close / error 回调：按当前状态分派。
   * connected → disconnected 并调度自动重连；connecting → 连接失败回退
   * uninitialized；closing → closeConfirmed 完成关闭；其余状态幂等忽略。
   */
  _handleDisconnected(): void {
    switch (this.status()) {
      case "connected":
        this.#transition("disconnect");
        this.#scheduleReconnect();
        break;
      case "connecting":
        this.#clearConnectTimer();
        this.#transition("fail");
        // 连接失败回退 uninitialized：不再自动重试，通知宿主（重连停止信号）
        this.#notifyAutoReconnectStopped();
        break;
      case "closing":
        this.#transition("closeConfirmed");
        break;
      default:
        break; // uninitialized / disconnected / closed：幂等忽略
    }
  }

  /**
   * 替换 WS 信道并重新绑定事件（AgentNodeService 复用节点时调用）。
   * 旧信道（若存在且不同）会被关闭；旧信道迟到的事件因 `#socket` 身份守卫被忽略，
   * 不会误伤新信道。
   */
  _attachSocket(socket: AgentNodeSocket): void {
    if (this.#socket !== null && this.#socket !== socket) {
      this.#socket.close();
    }
    this.#socket = socket;
    socket.onOpen(() => {
      if (this.#socket === socket) this._handleConnected();
    });
    socket.onClose(() => {
      if (this.#socket === socket) this._handleDisconnected();
    });
    socket.onError(() => {
      if (this.#socket === socket) this._handleDisconnected();
    });
  }

  /**
   * 启动运行实例的工厂入口（I3 实现）：在承载本节点的 WS 信道上创建 Instance。
   * 一个 AgentNode 可承载多个 Instance（N:1），Instance 的生命周期状态懒查询自本节点。
   */
  _spawnInstance(launchSpec: LaunchSpec): Instance {
    return new Instance({
      instanceId: `inst_${randomUUID()}`,
      environmentId: launchSpec.environmentId,
      agentConfigId: launchSpec.agentConfig.id,
      agentNode: this,
    });
  }

  // ---- 私有辅助 ----

  #transition(event: AgentNodeEvent): void {
    const previous = this.#fsm.getStatus();
    const next = this.#fsm.transition(event);
    this.#onStatusChange?.(next, previous);
  }

  /** 断连后调度一次自动重连；重试次数用尽后保持 disconnected，不再重试。 */
  #scheduleReconnect(): void {
    this.#clearReconnectTimer();
    if (this.#retryCount >= this.#maxRetries) {
      // 重试耗尽：通知宿主（AgentNodeService 据此在无实例引用时回收节点，
      // 避免断连后永久滞留 disconnected 状态占用管理集合）。
      this.#notifyAutoReconnectStopped();
      return;
    }
    this.#retryCount += 1;
    this.#reconnectTimer = this.#scheduler.setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.status() !== "disconnected") {
        return;
      }
      this.#transition("connect");
      this.#startConnectTimer();
    }, this.#reconnectDelayMs);
  }

  /** 进入 connecting 后启动连接超时；超时仍无 open 则回退 uninitialized。 */
  #startConnectTimer(): void {
    this.#clearConnectTimer();
    this.#connectTimer = this.#scheduler.setTimeout(() => {
      this.#connectTimer = null;
      if (this.status() !== "connecting") {
        return;
      }
      this.#transition("fail");
      // 重连超时回退 uninitialized：不再自动重试，通知宿主（重连停止信号）
      this.#notifyAutoReconnectStopped();
    }, this.#connectTimeoutMs);
  }

  /**
   * 通知宿主自动重连已停止（重试耗尽或重连失败回退 uninitialized）。
   * 节点此后不再自动恢复，宿主可据此回收无实例引用的节点。
   */
  #notifyAutoReconnectStopped(): void {
    this.#onAutoReconnectStopped?.();
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer !== null) {
      this.#scheduler.clearTimeout(this.#connectTimer);
      this.#connectTimer = null;
    }
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== null) {
      this.#scheduler.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }
}
