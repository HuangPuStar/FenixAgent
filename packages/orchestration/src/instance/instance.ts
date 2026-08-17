/**
 * Instance：Agent 运行实例的纯运行时载体。
 *
 * 职责：
 *   - 无 DB 持久化，生命周期部分跟随绑定它的 AgentNode（N 个 Instance 可共享
 *     同一个 AgentNode，一个 AgentNode 承载多个 Instance）
 *   - `status()` 为懒查询：每次调用实时计算，不缓存。未终止时从 AgentNode 生命周期
 *     状态推导；`stop()` 后返回 `stopped`
 *   - `send()` 通过 AgentNode 的 WS 信道发送数据（仅节点 connected 时合法）
 *   - `stop()` 只通知 Agent 进程停止（发送停止帧）并标记自身终止，**不关闭共享的
 *     AgentNode 连接**——关闭连接会影响同一节点上的其他实例；节点引用归还由
 *     AgentController.stopInstance 负责
 *
 * 状态推导规则：AgentNode 的 `connected` 视为实例 `running`；连接建立过程视为
 * `starting`；`closing`/`closed`/`destroyed` 视为 `stopped`。`disconnected` 是
 * 意外断连（非主动关闭），此时实例可用性不可确认，按 `error` 暴露给上层处理。
 */

import type { AgentNode } from "../agent-node/agent-node";
import { AgentNodeUnavailableError } from "../errors";
import type { AgentNodeStatus, InstanceInfo, InstanceStatus } from "../types/domain";

/** Instance 构造参数。 */
export interface InstanceParams {
  /** 实例唯一标识（由工厂生成）。 */
  instanceId: string;
  /** 来源环境 ID。 */
  environmentId: string;
  /** 来源 Agent 配置 ID。 */
  agentConfigId: string;
  /** 承载本实例的 AgentNode（N:1 关系中的 1）。 */
  agentNode: AgentNode;
}

/** AgentNode 生命周期状态 → Instance 可见状态的推导映射。 */
const NODE_TO_INSTANCE_STATUS: Record<AgentNodeStatus, InstanceStatus> = {
  uninitialized: "starting",
  connecting: "starting",
  connected: "running",
  disconnected: "error",
  closing: "stopped",
  closed: "stopped",
  destroyed: "stopped",
};

/** Agent 运行实例的纯运行时载体（无 DB 持久化）。 */
export class Instance {
  readonly instanceId: string;
  readonly environmentId: string;
  readonly agentConfigId: string;
  /** 远端机器标识，直接取自承载节点的 machineId。 */
  readonly machineId: string;
  readonly #agentNode: AgentNode;
  /** 终止标记：stop() 后置位，覆盖节点推导状态（共享节点下停止单个实例的唯一依据）。 */
  #terminated = false;

  constructor(params: InstanceParams) {
    this.instanceId = params.instanceId;
    this.environmentId = params.environmentId;
    this.agentConfigId = params.agentConfigId;
    this.#agentNode = params.agentNode;
    this.machineId = params.agentNode.machineId;
  }

  /** 懒查询实例状态：每次实时计算（终止标记 + AgentNode 状态推导），不做缓存。 */
  status(): InstanceStatus {
    if (this.#terminated) {
      return "stopped";
    }
    return NODE_TO_INSTANCE_STATUS[this.#agentNode.status()];
  }

  /**
   * 通过 AgentNode WS 发送数据；节点未连接时抛 AgentNodeUnavailableError。
   * 已终止（stop 后）的实例拒绝发送：终止标记置位后实例对节点不再可用，
   * 继续 send 会让调用方误以为消息可达，与 status() 返回 stopped 的语义矛盾。
   */
  send(data: unknown): void {
    if (this.#terminated) {
      throw new AgentNodeUnavailableError(`Instance ${this.instanceId} is terminated`);
    }
    this.#agentNode.send(data);
  }

  /**
   * 通知 Agent 进程停止：节点 connected 时发送带 instanceId 的停止帧（同一连接上
   * 可能承载多个实例，须标识目标），随后标记自身终止。不关闭共享的 AgentNode 连接；
   * 重复调用幂等。
   */
  stop(): void {
    if (this.#terminated) {
      return;
    }
    if (this.#agentNode.status() === "connected") {
      try {
        // 停止帧字段用 snake_case instance_id：与机器端（acp-link server.ts 的
        // instanceMgr.stop(msg.instance_id)）的协议约定一致，camelCase 会被机器忽略。
        this.#agentNode.send({ type: "stop", instance_id: this.instanceId });
      } catch {
        // 停止帧发送失败（断连窗口 / stale connected 信道不可用）：不阻断停止流程，
        // 仍标记终止，由上层 stopInstance 继续完成 core 停止与节点引用归还；
        // 否则 send 抛错会让 AgentController.stopInstance 中断，产生幽灵活跃表残留。
      }
    }
    this.#terminated = true;
  }

  /** 当前状态的不可变快照，用于对外查询与展示。 */
  info(): InstanceInfo {
    return {
      instanceId: this.instanceId,
      environmentId: this.environmentId,
      agentConfigId: this.agentConfigId,
      machineId: this.machineId,
      status: this.status(),
    };
  }
}
