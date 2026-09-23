/**
 * 项目专属 Yjs WS 适配层。
 * URL 构造逻辑保留在此文件（依赖浏览器 API）；
 * WS 连接/重连/消息解析委托给 @fenix/chat-channel 的同构实现。
 */

import {
  createYjsWsClient,
  type TerminalWsUiCode,
  WS_CLOSE_CODE_POLICY,
  type YjsWsClient,
  type YjsWsOptions,
  type YjsWsState,
} from "@fenix/chat-channel";

/** Re-export 类型，保持上游调用方无需改动 */
export type { YjsWsState };

/**
 * 终端关闭码对应的用户可读语义。
 * 服务端以这些码关闭时，YJS 客户端停止自动重连，由 UI 提供手动恢复入口。
 * 词表本体在 `@fenix/chat-channel` 的关闭码策略表（`transport/ws-close-codes.ts`），
 * 与传输层的「停不停重连」判定同源，此处只做转导，不再另立字面量。
 */
export type YjsTerminalErrorCode = TerminalWsUiCode;

export function getTerminalYjsWsErrorCode(code: number, reason?: string): YjsTerminalErrorCode | null {
  const entry = WS_CLOSE_CODE_POLICY.find((policy) => policy.code === code);
  if (!entry) return null;
  // 同一关闭码可能有多个语义来源，由策略表的 nonTerminalReason 标注非终态的那一个：
  // 1013 的慢消费者追赶超时（broadcaster SP-A7）自动重连后走全量快照同步恢复，
  // 不得展示"须手动恢复"的终态错误；其余原因（含容量拒绝）按 uiCode 展示。
  if (entry.nonTerminalReason !== undefined && entry.nonTerminalReason === reason) return null;
  return entry.uiCode;
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
