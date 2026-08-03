/**
 * AgentNode 生命周期状态机。
 *
 * 状态转移表（I2 设计文档）：
 *   uninitialized --connect----------> connecting       发起 WS 连接
 *   connecting    --open-------------> connected        连接成功
 *   connecting    --fail-------------> uninitialized    连接失败（error / 超时）
 *   connected     --disconnect-------> disconnected     意外断连
 *   disconnected  --connect----------> connecting       自动重连
 *   任一非终态    --closeRequested----> closing          主动关闭
 *   closing       --closeConfirmed----> closed          关闭完成（WS close 确认）
 *
 * 不在表中的组合一律抛 {@link IllegalStateTransitionError}（如 connected 时再次
 * connect）；closed / destroyed 为终态，不再接受任何事件。destroyed 保留类型完整性，
 * 当前流程不进入。
 */

import { IllegalStateTransitionError } from "../errors";
import type { AgentNodeStatus } from "../types/domain";

/** FSM 事件。 */
export type AgentNodeEvent =
  | "connect" // 发起连接（初始连接或自动重连）
  | "open" // WS 打开
  | "fail" // 连接失败（error / 超时）
  | "disconnect" // 意外断连
  | "closeRequested" // 主动关闭
  | "closeConfirmed"; // WS close 确认

/** 状态转移表：`当前状态 × 事件 → 目标状态`，未列出的组合为非法转换。 */
const TRANSITIONS: Record<AgentNodeStatus, Partial<Record<AgentNodeEvent, AgentNodeStatus>>> = {
  uninitialized: { connect: "connecting", closeRequested: "closing" },
  connecting: { open: "connected", fail: "uninitialized", closeRequested: "closing" },
  connected: { disconnect: "disconnected", closeRequested: "closing" },
  disconnected: { connect: "connecting", closeRequested: "closing" },
  closing: { closeConfirmed: "closed" },
  // 终态：不再接受任何转换
  closed: {},
  destroyed: {},
};

/** AgentNode 生命周期状态机。 */
export class AgentNodeFsm {
  #status: AgentNodeStatus;

  constructor(initial: AgentNodeStatus = "uninitialized") {
    this.#status = initial;
  }

  /** 懒查询当前状态：每次读取实时值，不做缓存。 */
  getStatus(): AgentNodeStatus {
    return this.#status;
  }

  /**
   * 执行一次状态转换，返回目标状态。
   * @throws IllegalStateTransitionError 当前状态下事件非法
   */
  transition(event: AgentNodeEvent): AgentNodeStatus {
    const next = TRANSITIONS[this.#status][event];
    if (next === undefined) {
      throw new IllegalStateTransitionError(`Invalid transition: ${this.#status} --${event}--> ?`);
    }
    this.#status = next;
    return next;
  }
}
