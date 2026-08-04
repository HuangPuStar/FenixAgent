/**
 * 编排域 AgentNode 桥接层：把新包 `packages/orchestration` 的 AgentNodeService
 * 接入现有 `src/` 的真实 WS 连接与配置（I4 集成第二阶段）。
 *
 * 职责：
 *   - 创建并持有 AgentNodeService 单例：idleTimeoutMs 取
 *     `config.acpIdleTimeoutSeconds * 1000`（与旧 acp-idle-monitor 的回收语义对齐），
 *     maxRetries 取 3（断连后至多自动重试 3 次，之后保持 disconnected 等待宿主重连）
 *   - 把现有 {@link WsConnection} 适配为 {@link AgentNodeSocket}：send 帧格式与
 *     `acp-ws-handler.sendToWs` 一致（JSON.stringify + "\n"），close 保证最终触发
 *     onClose（AgentNode 依赖该回调完成 closing → closed 确认）
 *   - 事件分发：WsConnection 接口本身没有 open/close/error 事件（route 层在
 *     onOpen/onClose 回调中驱动），断连时由 acp-ws-handler 显式调用
 *     {@link dispatchAgentNodeWsClose}，触发 AgentNode 的 `_handleDisconnected`
 *     （进入 disconnected 并调度自动重连）。open 事件无需分发：
 *     handleIncomingConnection 内部已把节点视为已打开。
 */

import { error as logError } from "@fenix/logger";
import { AgentNodeService, type AgentNodeSocket, AgentNodeUnavailableError } from "@fenix/orchestration";
import { config } from "../config";
import type { WsConnection } from "./ws-types";

/** 创建编排域 AgentNodeService 单例（可按需重复调用，但宿主应复用导出单例）。 */
export function createAgentNodeService(): AgentNodeService {
  // 防御：本模块可能早于 applyEnv(validateEnv()) 被求值（index.ts 静态导入在
  // 顶层代码之前执行），此时 config.acpIdleTimeoutSeconds 为 undefined，
  // undefined * 1000 = NaN 会让 setTimeout(fn, NaN) 立即触发——机器注册后瞬间被
  // 空闲回收关闭。兜底 300s 与 env.ts 的 zod default 保持一致。
  const idleTimeoutSeconds = Number.isFinite(config.acpIdleTimeoutSeconds) ? config.acpIdleTimeoutSeconds : 300;
  return new AgentNodeService({
    idleTimeoutMs: idleTimeoutSeconds * 1000,
    maxRetries: 3,
  });
}

let agentNodeServiceInstance: AgentNodeService | null = null;

/**
 * 编排域 AgentNodeService 惰性单例：machine 连接接入、节点生命周期与空闲回收的统一入口。
 *
 * 必须惰性创建：模块加载即执行（静态导入提升），早于 index.ts 的
 * applyEnv(validateEnv())；此时读取 config.acpIdleTimeoutSeconds 会得到 undefined
 * （NaN 定时器导致注册后立即断连）。首次调用发生在请求处理期，config 已就绪。
 */
export function getAgentNodeService(): AgentNodeService {
  if (agentNodeServiceInstance === null) {
    agentNodeServiceInstance = createAgentNodeService();
  }
  return agentNodeServiceInstance;
}

/** 已适配的 socket 注册表：以 WsConnection 对象为键，供事件分发时反查。 */
const adapters = new WeakMap<WsConnection, WsAgentNodeSocket>();

/**
 * WsConnection → AgentNodeSocket 适配器。
 *
 * 事件语义（与 AgentNodeSocket 契约一致）：每个事件只保留一个 handler，
 * 重复注册覆盖前一个；close() 必须最终触发 onClose。
 */
class WsAgentNodeSocket implements AgentNodeSocket {
  readonly #ws: WsConnection;
  #onClose: (() => void) | null = null;

  constructor(ws: WsConnection) {
    this.#ws = ws;
  }

  /** 发送数据帧；帧格式与 acp-ws-handler.sendToWs 保持一致（NDJSON）。 */
  send(data: unknown): void {
    // readyState!==1（断连/关闭中）时静默丢弃会让调用方误以为消息可达（停止帧丢失
    // 无回执）。显式抛错保证「断连即失败」，与 AgentNode.send 的 connected 门禁语义
    // 一致；sweep 路径未透传断连事件导致节点 stale connected 时，此处是最后防线。
    if (this.#ws.readyState !== 1) {
      throw new AgentNodeUnavailableError("Agent node socket is not open");
    }
    try {
      this.#ws.send(`${JSON.stringify(data)}\n`);
    } catch (err) {
      logError("agent-node send error:", err);
    }
  }

  /**
   * 主动关闭底层连接并触发 onClose。
   *
   * 真实 WS close 事件随后到达时（route → handleAcpWsClose → dispatch）会重复触发
   * onClose，AgentNode 的 FSM 对终态幂等忽略，无需去重。
   */
  close(): void {
    try {
      if (this.#ws.readyState === 1) {
        this.#ws.close(1000, "agent node closed");
      }
    } catch (err) {
      logError("agent-node close error:", err);
    }
    this.#onClose?.();
  }

  /**
   * open 事件无需分发：handleIncomingConnection 内部已把节点视为已打开，
   * 注册的回调永远不被触发（AgentNodeSocket 契约要求实现该方法）。
   */
  onOpen(_handler: () => void): void {}

  onClose(handler: () => void): void {
    this.#onClose = handler;
  }

  /** error 按断连处理（AgentNode._handleDisconnected 覆盖 error 分支），无需单独分发。 */
  onError(_handler: () => void): void {}

  /** 桥接层事件分发入口：触发已注册的 close handler。 */
  emitClose(): void {
    this.#onClose?.();
  }
}

/**
 * 把现有 WsConnection 适配为 AgentNodeSocket。
 * 同一 WsConnection 对象重复调用返回同一适配器（事件 handler 以最后一次注册为准）。
 * 调用方必须传入与 handleIncomingConnection 时相同的 entry.ws 对象，分发才可反查到适配器。
 */
export function wsToAgentNodeSocket(ws: WsConnection): AgentNodeSocket {
  let adapter = adapters.get(ws);
  if (!adapter) {
    adapter = new WsAgentNodeSocket(ws);
    adapters.set(ws, adapter);
  }
  return adapter;
}

/**
 * 分发机器断连事件（acp-ws-handler 在确认 machine 清理时调用）。
 * 未注册的 ws（非 machine 连接）静默忽略。
 */
export function dispatchAgentNodeWsClose(ws: WsConnection): void {
  const adapter = adapters.get(ws);
  if (!adapter) return;
  adapter.emitClose();
}

/**
 * 按 machineId 分发机器断连事件（无 WsConnection 可引用时使用，如
 * registry-heartbeat sweep 清理路径：connections 中已无该 machine 的 entry）。
 * 与 dispatchAgentNodeWsClose 等效——最终都触发 AgentNode._handleDisconnected；
 * 节点未管理 / 已断连时幂等忽略。
 */
export function dispatchAgentNodeDisconnect(machineId: string): void {
  getAgentNodeService().notifyNodeDisconnected(machineId);
}
