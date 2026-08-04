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
  const handle = await facade.connectInstanceRelay({ instanceId, sessionId });
  const full = handle as FullRelayHandle;
  if (full.ready) await full.ready;
  return handle;
}
