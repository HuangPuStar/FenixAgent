/**
 * Agent Relay 连接工厂 — 中立于前端/后端传输层的共享模块。
 *
 * 通过 CoreRuntimeFacade 连接 Agent relay handle，
 * 共享于 WS relay、Yjs 前端、HTTP OpenAI 端点、Workflow 等场景。
 */

import { error as logError } from "@fenix/logger";
import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import { getBoundCoreRuntime } from "../services/core-runtime-port";

/** EngineRelayHandle 的扩展类型（含 onMessage / ready） */
export type FullRelayHandle = EngineRelayHandle & {
  onMessage?: (listener: (message: { type: string; payload?: unknown }) => void) => () => void;
  ready?: Promise<void>;
};

/**
 * 通过 CoreRuntimeFacade 连接 Agent relay handle。
 * 共享于 WS relay 和 HTTP OpenAI 端点。
 *
 * @param requestId 触发本次连接的关联 ID（§7）：由调用方解析（HTTP 请求上下文或独立入口自建），
 *   随 ConnectInstanceRelayRequest 进入 core 的 relay 链路；缺省时不携带。
 */
export async function connectAgentRelay(
  instanceId: string,
  sessionId: string,
  requestId?: string,
): Promise<EngineRelayHandle> {
  const facade = getBoundCoreRuntime();
  const snapshot = facade.getInstance(instanceId);
  const identity =
    snapshot?.runtimeGeneration !== undefined && snapshot.serverEpoch
      ? { runtimeGeneration: snapshot.runtimeGeneration, serverEpoch: snapshot.serverEpoch }
      : undefined;
  const reclaimCapturedRuntime = async () => {
    // 连接失败只能影响连接建立时捕获的实体，不能按稳定 UID 回收后来的运行代次。
    if (snapshot?.nodeId !== "local-default" || !identity) return;
    try {
      const { terminateLocalDeadInstance } = await import("../../services/orchestration-instance");
      await terminateLocalDeadInstance(instanceId, identity);
    } catch (error) {
      logError(`[agent-relay] runtime death cleanup failed: instanceId=${instanceId}`, error);
    }
  };
  let handle: EngineRelayHandle | undefined;
  try {
    handle = await facade.connectInstanceRelay({ instanceId, sessionId, requestId });
    handle.onMessage?.((message) => {
      if (message.type === "relay_closed") void reclaimCapturedRuntime();
    });
    if (handle.ready) await handle.ready;
    return handle;
  } catch (error) {
    // 句柄是当前消费者租约；握手失败只释放本消费者的监听器。
    try {
      await handle?.close();
    } catch (cleanupError) {
      logError(`[agent-relay] consumer lease release failed: instanceId=${instanceId}`, cleanupError);
    }
    await reclaimCapturedRuntime();
    throw error;
  }
}
