/**
 * 项目专属 Yjs WS 适配层。
 * URL 构造逻辑保留在此文件（依赖浏览器 API）；
 * WS 连接/重连/消息解析委托给 @fenix/acp-server 的同构实现。
 */

import { createYjsWsClient, type YjsWsClient, type YjsWsOptions, type YjsWsState } from "@fenix/acp-server";

/** Re-export 类型，保持上游调用方无需改动 */
export type { YjsWsState };

/**
 * 终端关闭码对应的用户可读语义。
 * 服务端以这些码关闭时，YJS 客户端停止自动重连，由 UI 提供手动恢复入口。
 */
export type YjsTerminalErrorCode =
  | "instance_idle_reclaimed"
  | "machine_unavailable"
  | "client_keepalive_timeout"
  | "environment_unavailable";

export function getTerminalYjsWsErrorCode(code: number): YjsTerminalErrorCode | null {
  if (code === 4001) return "instance_idle_reclaimed";
  if (code === 4004) return "environment_unavailable";
  if (code === 4500) return "machine_unavailable";
  if (code === 4501) return "client_keepalive_timeout";
  return null;
}

/** Build the YJS WebSocket URL for a given agent */
export function buildYjsUrl(agentId: string, sessionId?: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}/acp/yjs/${agentId}`;
  const params = new URLSearchParams();
  const activeOrgId = localStorage.getItem("active_org_id");
  if (activeOrgId) {
    params.set("active_org_id", activeOrgId);
  }
  if (sessionId) {
    params.set("sessionId", sessionId);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function createYjsWs(options: YjsWsOptions): YjsWsClient {
  return createYjsWsClient(options);
}
