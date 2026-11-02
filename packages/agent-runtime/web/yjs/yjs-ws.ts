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
    params.set("activeOrganizationId", activeOrgId);
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

// ── 新聊天同步协议（隔离路径）的浏览器接入原语 ──
//
// 新协议复用同一个已认证 endpoint，但帧是 UTF-8 JSON 二进制帧。以下导出只服务
// `sync-transport.ts`：新增导出不改变旧 `createYjsWs` / URL 构造的任何行为。

/** 浏览器 WebSocket 的最小结构面：测试用同形状替身即可，不依赖 DOM 事件对象。 */
export interface SyncBrowserSocket {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: unknown) => void) | null;
  onclose: ((code: number, reason: string, wasClean: boolean) => void) | null;
  onerror: (() => void) | null;
}

export type SyncBrowserSocketFactory = (url: string) => SyncBrowserSocket;

/** 浏览器 WebSocket 适配：事件回调收敛成最小结构面，避免测试伪造 DOM 事件。 */
export function createBrowserSyncSocket(url: string): SyncBrowserSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const socket: SyncBrowserSocket = {
    get binaryType() {
      return ws.binaryType;
    },
    set binaryType(value: string) {
      ws.binaryType = value === "blob" ? "blob" : "arraybuffer";
    },
    get readyState() {
      return ws.readyState;
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    // 控制帧很小；复制到独立 ArrayBuffer 以避开 SharedArrayBuffer 与 DOM send 的类型不兼容。
    send: (data) => {
      const copy = new ArrayBuffer(data.byteLength);
      new Uint8Array(copy).set(data);
      ws.send(copy);
    },
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => socket.onmessage?.(event.data);
  ws.onclose = (event) => socket.onclose?.(event.code, event.reason, event.wasClean);
  ws.onerror = () => socket.onerror?.();
  return socket;
}

/**
 * 新同步协议 socket URL：复用旧 URL 的全部 query（组织、实例、RCS 会话），再显式标记 `chatSync=1`。
 * 标记只影响服务端分流，不新建通道。
 */
export function buildSyncChatSocketUrl(agentId: string, locator: YjsChatLocator): string {
  const url = new URL(buildYjsUrl(agentId, locator));
  url.searchParams.set("chatSync", "1");
  return url.toString();
}

/** 前端默认使用新协议；只有显式 `?chatSync=0` 回退，不依赖服务端环境变量。 */
export function readSyncChatSwitch(search: string): boolean {
  return new URLSearchParams(search).get("chatSync") !== "0";
}

/** 显式调试后备的内容块列表；正常由 MANIFEST → directory `root.contentDocIds` 发现。逗号分隔，去空去重。 */
export function readSyncChatContentDocIds(search: string): string[] {
  const raw = new URLSearchParams(search).get("chatSyncDocs");
  if (raw === null) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

/** HELLO 代次（服务端接线前用于满足握手校验；未提供时省略）。 */
export function readSyncChatGeneration(search: string): string | undefined {
  const raw = new URLSearchParams(search).get("chatSyncGeneration")?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

/** 新协议 HELLO scope 的组织来源：与旧 YJS URL 共用同一个读取契约点。 */
export function readSyncChatOrganizationId(): string | null {
  return readActiveOrgId();
}

/**
 * 新协议帧是 UTF-8 JSON（首字节 `{`）。这里只做旁路镜像所需的轻量解码：非 JSON、非对象返回 null，
 * 真正的 schema 校验由 sync-client 的 transport 完成。
 */
export function decodeSyncWireJson(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.byteLength === 0 || bytes[0] !== 0x7b) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 标准 base64 解码（帧 schema 只接受该形态）；失败返回 null，由 transport 的严格解码报错。 */
export function decodeSyncBase64Payload(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** 把 WebSocket 的二进制事件统一成 Uint8Array；文本/未知类型返回 null。 */
export function syncSocketBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
