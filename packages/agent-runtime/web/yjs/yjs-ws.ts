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
import { readActiveOrgId } from "@fenix/web-runtime/lib/active-org";

/** Re-export 类型，保持上游调用方无需改动 */
export type { YjsWsState };

/**
 * 关闭码 → 客户端处置（策略表两列的合并视图）：`terminal` 是传输层语义（不再自动重连），
 * `uiCode` 是 UI 语义（渲染什么状态）。判据与逐码结果都在 `@fenix/chat-channel` 的策略表，
 * 本函数只是转导，不另立字面量。
 *
 * `nonTerminalReason` 的例外只对「同一码有两个语义来源」的码生效（当前仅 1013）：带该 reason
 * 关闭时本轮按非终态处理（自动重连后由全量快照同步恢复），此时 `terminal` 与 `uiCode` 都回到空值。
 */
export interface YjsWsCloseOutcome {
  terminal: boolean;
  uiCode: TerminalWsUiCode | null;
}

export function resolveYjsWsCloseOutcome(code: number, reason?: string): YjsWsCloseOutcome {
  const entry = WS_CLOSE_CODE_POLICY.find((policy) => policy.code === code);
  if (!entry) return { terminal: false, uiCode: null };
  if (entry.nonTerminalReason !== undefined && entry.nonTerminalReason === reason) {
    return { terminal: false, uiCode: null };
  }
  return { terminal: entry.stopReconnect, uiCode: entry.uiCode };
}

/**
 * 终端关闭码对应的用户可读语义。
 * 服务端以这些码关闭时，YJS 客户端停止自动重连，由 UI 提供手动恢复入口。
 * 词表本体在 `@fenix/chat-channel` 的关闭码策略表（`transport/ws-close-codes.ts`），
 * 与传输层的「停不停重连」判定同源，此处只做转导，不再另立字面量。
 */
export type YjsTerminalErrorCode = TerminalWsUiCode;

export function getTerminalYjsWsErrorCode(code: number, reason?: string): YjsTerminalErrorCode | null {
  // 与 `resolveYjsWsCloseOutcome` 同源同实现，避免两处对同一张表各写一份判定。
  return resolveYjsWsCloseOutcome(code, reason).uiCode;
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
  // 组织参数只经契约读取（前端规范 §3.3）：WS 握手无法带 `X-Active-Org-Id` 头，服务端按
  // header → query → cookie 的优先级提取组织，因此这里是唯一必须走 query 的通道。
  const activeOrgId = readActiveOrgId();
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
