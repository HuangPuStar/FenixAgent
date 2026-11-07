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

/** 当前运行的服务端身份；缺少代次时不能证明跨连接连续性。 */
export function getAgentRuntimeIdentity(instanceId: string): string | undefined {
  const snapshot = getBoundCoreRuntime().getInstance(instanceId);
  return snapshot?.status === "running" && snapshot.runtimeGeneration !== undefined && snapshot.serverEpoch
    ? JSON.stringify([snapshot.serverEpoch, snapshot.runtimeGeneration])
    : undefined;
}

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
      // 远端子进程死亡只广播 connected:false（machine 连接仍在）：按 runtimeGeneration 作废旧代实体，
      // 使重连时的 ensure 经 Coordinator 启动新进程，而不是复用已死的 core runtime。
      if (message.type !== "status") return;
      const payload = message.payload as { connected?: unknown; runtimeGeneration?: unknown } | null | undefined;
      if (payload?.connected !== false || typeof payload.runtimeGeneration !== "number") return;
      const generation = payload.runtimeGeneration;
      void import("../../services/orchestration-instance")
        .then(({ terminateRemoteDeadInstance }) => {
          terminateRemoteDeadInstance(instanceId, generation);
        })
        .catch((error) => {
          logError(`[agent-relay] dead runtime cleanup failed: instanceId=${instanceId}`, error);
        });
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
