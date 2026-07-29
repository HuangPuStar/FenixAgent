/**
 * 项目专属 Yjs WS 适配层。
 * URL 构造逻辑保留在此文件（依赖浏览器 API）；
 * WS 连接/重连/消息解析委托给 @fenix/acp-server 的同构实现。
 */

import { createYjsWsClient, type YjsWsOptions, type YjsWsState } from "@fenix/acp-server";

/** Re-export 类型，保持上游调用方无需改动 */
export type { YjsWsState };

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

export function createYjsWs(options: Pick<YjsWsOptions, "onYjsUpdate" | "onConnectionState"> & { url: string }) {
  return createYjsWsClient(options);
}
