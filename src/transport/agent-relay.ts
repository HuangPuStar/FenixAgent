/**
 * Agent Relay 连接工厂 — 中立于前端/后端传输层的共享模块。
 *
 * 通过 CoreRuntimeFacade 连接 Agent relay handle，
 * 共享于 WS relay、Yjs 前端、HTTP OpenAI 端点、Workflow 等场景。
 */

import type { EngineRelayHandle } from "@fenix/plugin-sdk";

/** EngineRelayHandle 的扩展类型（含 onMessage / ready） */
export type FullRelayHandle = EngineRelayHandle & {
  onMessage?: (listener: (message: { type: string; payload?: unknown }) => void) => () => void;
  ready?: Promise<void>;
};

/**
 * 通过 CoreRuntimeFacade 连接 Agent relay handle。
 * 共享于 WS relay 和 HTTP OpenAI 端点。
 */
export async function connectAgentRelay(instanceId: string, sessionId: string): Promise<EngineRelayHandle> {
  const { getCoreRuntime } = await import("../services/core-bootstrap");
  const facade = getCoreRuntime();
  try {
    const handle = await facade.connectInstanceRelay({ instanceId, sessionId });
    const full = handle as FullRelayHandle;
    if (full.ready) await full.ready;
    return handle;
  } catch (err) {
    // 本地实例 relay 无法建立（进程已死且无法重生）：触发实例级清理，
    // 让下一次 ensureRunning 重新 spawn 而非无限复用死实例（C-P2.4）。
    // 远程实例/已停止实例由 terminateLocalDeadInstance 内部校验排除；
    // "local-default" 与 local-node-service 的 LOCAL_DEFAULT_NODE_ID 保持一致。
    const snapshot = facade.getInstance(instanceId);
    if (snapshot?.nodeId === "local-default" && (snapshot.status === "running" || snapshot.status === "error")) {
      const { terminateLocalDeadInstance } = await import("../services/orchestration-instance");
      void terminateLocalDeadInstance(instanceId);
    }
    throw err;
  }
}
