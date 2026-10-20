import type { SyncChatProjection } from "./sync-doc-hub";
import type { SyncBrowserSocketFactory } from "./yjs-ws";

/** 与 `sync/protocol/frames.ts` 的 `SYNC_PROTOCOL_VERSION` 对齐（帧层不向浏览器出口暴露该常量）。 */
export const SYNC_PROTOCOL_VERSION = 1;

/** 新协议连接状态与 transport 注入端口；不包含服务端运行时依赖。 */
export type SyncChatStatus = "idle" | "connecting" | "handshaking" | "ready" | "reconnecting" | "error" | "closed";

export interface SyncManifestSummary {
  readonly generation: string;
  readonly pointerRevision: number;
  readonly referenceRevision: number;
  readonly controlDocId: string;
  readonly runtimeDocId: string;
  readonly directoryDocId: string;
  readonly recoveryState: string | null;
}

export interface SyncChatConnectionState {
  readonly status: SyncChatStatus;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly generation: string | null;
  readonly manifest: SyncManifestSummary | null;
  readonly subscribedDocIds: readonly string[];
  /** 是否有更早内容可加载（未订阅的历史块，或已订阅但仍被投影窗口挡住的条目）。 */
  readonly hasEarlierHistory: boolean;
  /** 是否存在中间缺口：向历史翻页时被淘汰、尚未重新加载的较新区间。 */
  readonly hasLaterHistory: boolean;
  /** “加载更早”的历史块基线尚在途；UI 据此禁用重复点击。 */
  readonly historyLoading: boolean;
  readonly reconnectAttempt: number;
  /** 初次基线（MANIFEST 后首批 DOC_BASE）尚未全部落地；展示层据此收起半成品。 */
  readonly hydrating: boolean;
}

export const INITIAL_SYNC_CHAT_STATE: SyncChatConnectionState = Object.freeze({
  status: "idle",
  error: null,
  generation: null,
  manifest: null,
  subscribedDocIds: Object.freeze([]),
  hasEarlierHistory: false,
  hasLaterHistory: false,
  historyLoading: false,
  reconnectAttempt: 0,
  hydrating: false,
});

export interface SyncChatSessionOptions {
  readonly agentId: string;
  readonly instanceUid: string;
  readonly rcsSessionId: string;
  readonly organizationId: string;
  /** 显式测试/调试后备；正常联调从 MANIFEST 与目录 Doc 发现内容块。 */
  readonly contentDocIds?: readonly string[];
  /** 显式调试后备；正常握手不发送预设代次，等待服务端 MANIFEST。 */
  readonly generation?: string;
  /** 完整 URL 覆盖（测试用）；默认复用已认证的 `/acp/yjs/:agentId`。 */
  readonly url?: string;
  readonly socketFactory?: SyncBrowserSocketFactory;
  readonly now?: () => number;
  readonly yieldToHost?: () => Promise<void>;
  readonly autoReconnect?: boolean;
  readonly reconnectDelaysMs?: readonly number[];
  /** 基线 ACK 等待上限（测试/调试注入）；缺省 5s。 */
  readonly syncBaseTimeoutMs?: number;
  readonly schedule?: (task: () => void, delayMs: number) => () => void;
  readonly onState?: (state: SyncChatConnectionState) => void;
  readonly onProjection?: (projection: SyncChatProjection) => void;
}

export interface SyncChatSession {
  connect(): void;
  dispose(): void;
  state(): SyncChatConnectionState;
  /** 显式加载一批更早历史；没有可加载内容时返回 false，不产生网络请求。 */
  loadEarlierHistory(): boolean;
  /** 显式补齐中间缺口（向下阅读）；没有可加载内容时返回 false。 */
  loadLaterHistory(): boolean;
  /**
   * 回到最新位置：有界定位最新区间并等待基线完成后再返回。
   * 发送新消息与用户显式“回到最新”共用；超时返回 false。
   */
  returnToLatestHistory(): Promise<boolean>;
}
