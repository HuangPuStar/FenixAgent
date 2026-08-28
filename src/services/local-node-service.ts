/**
 * 本地执行节点服务：为编排域提供 local-default 占位 AgentNode。
 *
 * 背景：编排域 AgentController 的节点抽象（AgentNode）绑定远端 machine 的
 * WS 连接（send/status/stop 均经节点信道）。但 RCS 支持"未配置 machineId 时
 * 回退本地执行"（旧路径 nodeId 三选一：agent config 绑定 > RCS_DEFAULT_MACHINE_ID
 * > local-default），本地进程不经 WS——编排域模型不覆盖该场景。
 *
 * 本层在宿主侧弥合差异，不动编排域包：
 *   - `ensureNode("local-default")` 返回预构造的本地 AgentNode（stub socket，
 *     构造即 connected，永不触发断连事件；send 空操作——宿主侧无编排域
 *     Instance.send 的调用点，本地执行的消息通道是 core relay）；
 *   - `releaseNode("local-default")` 空操作（本地节点无引用计数，随进程生命周期
 *     常驻）；
 *   - 其他 machineId 原样委托真实 AgentNodeService（远程机器 WS 节点）。
 *
 * 注意：local-default 节点"恒 connected"是有意语义——本地执行能力（进程内
 * acp-link server）不会随单个实例崩溃消失，且节点为 N:1 共享（一个 stub socket
 * 承载全部本地实例），节点级断连会把健康实例一并误标 error。实例级死亡处理
 * 见 orchestration-instance.terminateLocalDeadInstance（由 relay 死亡信号触发）。
 *
 * 编排域语义保持：无 machineId 且本地执行被禁用（RCS_DISABLE_LOCAL_EXECUTION）
 * 时，EnvironmentRepo 返回 machineId=null，AgentController 仍以配置错误拒绝启动。
 */

import { AgentNode, type AgentNodeServicePort, type AgentNodeSocket } from "@fenix/orchestration";
import { getAgentNodeService } from "../transport/agent-node-bridge";

/** 本地执行占位节点 ID（与旧路径 nodeId 兜底语义一致，core 侧同名注册）。 */
export const LOCAL_DEFAULT_NODE_ID = "local-default";

/**
 * 本地节点的 stub 信道：注册回调但永不触发事件；close 立即确认关闭。
 *
 * send 空操作是有意为之：本地执行的 ACP 消息走 core relay（connectAgentRelay），
 * 不经节点信道；编排域 Instance.send 在宿主侧无调用点（前端 Chat 走 YJS relay、
 * HTTP 调用走 agent-chat-service），此处仅满足 AgentNodeSocket 契约。
 */
class LocalStubSocket implements AgentNodeSocket {
  #onClose: (() => void) | null = null;

  onOpen(_handler: () => void): void {}

  onClose(handler: () => void): void {
    this.#onClose = handler;
  }

  onError(_handler: () => void): void {}

  send(_data: unknown): void {}

  /** AgentNode.close() 依赖该回调完成 closing → closed 确认。 */
  close(): void {
    this.#onClose?.();
  }
}

/** 本地节点感知的 AgentNodeService 包装：local-default 分流，其余委托。 */
export class LocalNodeAwareService implements AgentNodeServicePort {
  readonly #getDelegate: () => AgentNodeServicePort;
  #localNode: AgentNode | null = null;

  constructor(getDelegate: () => AgentNodeServicePort) {
    this.#getDelegate = getDelegate;
  }

  ensureNode(machineId: string): AgentNode {
    if (machineId === LOCAL_DEFAULT_NODE_ID) {
      if (!this.#localNode) {
        const node = new AgentNode({
          machineId,
          socket: new LocalStubSocket(),
        });
        // 本地执行视为常驻在线：直接推进 connected（本地 stub 信道永不触发断连事件，
        // E-P2.2 方案 A 移除重连配置后本地节点本就无需重连语义）
        node._handleConnected();
        this.#localNode = node;
      }
      return this.#localNode;
    }
    return this.#getDelegate().ensureNode(machineId);
  }

  releaseNode(machineId: string): void {
    if (machineId === LOCAL_DEFAULT_NODE_ID) {
      return;
    }
    this.#getDelegate().releaseNode(machineId);
  }
}

/** 本地节点感知的 AgentNodeService 单例（编排域装配层注入 AgentController）。 */
export const localNodeAwareAgentNodeService = new LocalNodeAwareService(getAgentNodeService);
