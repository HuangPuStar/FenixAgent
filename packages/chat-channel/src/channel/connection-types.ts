// packages/chat-channel/src/channel/connection-types.ts
// 连接层类型（迁移自 src/transport/relay/yjs-frontend/types.ts，语义原样保留）。
//
// ClientConnection / SharedRelay 承载多标签页共享 relay handle 的引用计数语义：
// 同一 instanceId + userId 的多个前端连接共享同一 SharedRelay，引用计数归零才释放。
// WsConnection 为最小 WebSocket 抽象（纯接口，无框架依赖），宿主侧适配注入。

import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";

export type RelayMessage = EngineRelayMessage;

/** 最小 WebSocket 连接抽象：与传输框架解耦（Elysia WS / Hono WSContext 适配为同一形状） */
export interface WsConnection {
  /** 向客户端发送文本数据 */
  send(data: string): void;
  /** 以指定码与原因关闭连接 */
  close(code?: number, reason?: string): void;
  /** 当前就绪状态（0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED） */
  readonly readyState: number;
}

/** 单个前端 WebSocket 客户端在连接生命周期内的全部状态 */
export interface ClientConnection {
  ws: WsConnection;
  userId: string;
  agentId: string;
  relayHandle: EngineRelayHandle;
  relayUnsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval>;
  instanceId: string;
  /** RCS 会话标识符 (rcs_xxx)，连接生命周期内不变 */
  rcsSessionId: string;
  /** 当前活跃的 ACP 会话标识符 (ses_xxx)，session/new、session/load 后更新；初始为 null */
  acpSessionId: string | null;
  /** 是否已执行过至少一次 load_session（用于区分重连首次加载 vs 后续正常切换） */
  sessionLoaded: boolean;
  workspacePath: string | null;
  openTime: number;
  pendingMessages: string[];
  relayReady: boolean;
  /** agent 是否已发送过 status（确认 ACP 初始化完成） */
  agentStatusReceived: boolean;
  /** 客户端最近一次发送 keep_alive 的时间戳（ms），用于判断页面是否隐藏 */
  lastClientKeepalive: number;
}

/**
 * 同一 instanceId + userId 的前端连接共享的 relay 句柄。
 * refCount 归零（最后客户端断开）后由 gateway 统一释放；relay_closed 后由
 * relay-event-handler 触发实例级清理并销毁对应实时资源。
 */
export interface SharedRelay {
  handle: EngineRelayHandle;
  unsubscribe: (() => void) | null;
  refCount: number;
  userId: string;
  agentId: string;
  instanceId: string;
  /** 空闲监控已记录为 relay 已连接，最后释放时必须成对注销。 */
  idleMonitorAttached?: boolean;
  /** RCS 会话标识符，同一实例的所有前端连接共享 */
  rcsSessionId: string;
  /** 服务端根据 environment 解析的工作目录，供 ACP session RPC 使用 */
  workspacePath: string;
  /** session/list 定时轮询器，用于同步 agent 侧 session 变更到 Chat Doc */
  sessionListTimer?: ReturnType<typeof setInterval>;
  /** 销毁标志，timer 回调中检查避免被 GC 前仍发送 RPC */
  destroyed?: boolean;
  /** JSON-RPC 请求 id 递增计数器，保证同一 instance 下 translateSimpleAction 生成唯一 id */
  nextRpcId: number;
}
