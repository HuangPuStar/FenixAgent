/**
 * 项目专属 Yjs WS 适配层。
 * URL 构造逻辑保留在此文件（依赖浏览器 API）；
 * WS 连接/重连/消息解析委托给 @fenix/chat-channel 的同构实现。
 */

import { createYjsWsClient, type YjsWsClient, type YjsWsOptions, type YjsWsState } from "@fenix/chat-channel";

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
  | "environment_unavailable"
  | "spawn_rejected"
  | "too_many_connections";

export function getTerminalYjsWsErrorCode(code: number, reason?: string): YjsTerminalErrorCode | null {
  if (code === 4001) return "instance_idle_reclaimed";
  if (code === 4004) return "environment_unavailable";
  if (code === 4500) return "machine_unavailable";
  if (code === 4501) return "client_keepalive_timeout";
  if (code === 4502) return "spawn_rejected";
  // 1013 有两个语义来源，按 close reason 区分：
  // - 连接数超限（gateway 容量拒绝）：重试相同 URL 在配额释放前无意义 → 终态；
  // - 慢消费者追赶超时（broadcaster SP-A7）：非终态——客户端自动重连后走全量
  //   快照同步恢复，不得展示"须手动恢复"的终态错误。
  // 未知 reason 的 1013 保持终态（与既有容量语义一致）。
  if (code === 1013) return reason === "slow consumer resync timeout" ? null : "too_many_connections";
  return null;
}

export interface YjsChatLocator {
  instanceUid: string;
  rcsSessionId: string;
  acpSessionId?: string;
}

/** 构造显式区分实例、RCS Doc 与 ACP 会话的 YJS WebSocket URL。 */
export function buildYjsUrl(agentId: string, locator: YjsChatLocator): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}/acp/yjs/${agentId}`;
  const params = new URLSearchParams();
  const activeOrgId = localStorage.getItem("active_org_id");
  if (activeOrgId) {
    params.set("active_org_id", activeOrgId);
  }
  params.set("instanceUid", locator.instanceUid);
  params.set("rcsSessionId", locator.rcsSessionId);
  if (locator.acpSessionId) {
    params.set("acpSessionId", locator.acpSessionId);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function createYjsWs(options: YjsWsOptions): YjsWsClient {
  return createYjsWsClient(options);
}
