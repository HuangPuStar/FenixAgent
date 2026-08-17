// packages/chat-channel/src/channel/connection-types.ts
// 连接层类型（迁移自 src/transport/relay/yjs-frontend/types.ts，语义原样保留）。
//
// ClientConnection / SharedRelay 承载多标签页共享 relay handle 的引用计数语义：
// 同一 instanceId + userId 的多个前端连接共享同一 SharedRelay，引用计数归零才释放。
// WsConnection 为最小 WebSocket 抽象（纯接口，无框架依赖），宿主侧适配注入。

import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";

export type RelayMessage = EngineRelayMessage;

/**
 * load_session 回放窗口时长（ms）。load/resume 的 RPC 转发时开启（早于 Agent 历史
 * 回放流到达，JSON-RPC result 分支兜底重置），窗口内且 Chat Doc 无时间线内容时，
 * 到达的 Agent 历史回放（无头增量流 / 无 turnId user_message）由 relay-event-handler
 * 补全 turn 上下文投影时间线——无持久化快照时历史恢复的唯一来源；窗口外或
 * doc 已有内容（重连跳过回放语义）保持原语义由聚合层拒绝。
 */
export const REPLAY_WINDOW_MS = 10_000;

/**
 * prompt 静默超时阈值（ms）。send_prompt 登记后若 agent 全程无任何业务帧
 * （流式输出/事件/JSON-RPC 响应均刷新 lastInboundAt，保活帧除外）持续超过该阈值，
 * 判定 prompt 已卡死（如被路由到错误 session 后 agent 无响应），收敛 turn_failed，
 * 防止前端 loading 永久卡死。期间有任何业务帧则超时判定顺延，不误杀长输出。
 */
export const PROMPT_TIMEOUT_MS = 5 * 60_000;

/** 最小 WebSocket 连接抽象：与传输框架解耦（Elysia WS / Hono WSContext 适配为同一形状） */
export interface WsConnection {
  /**
   * 向客户端发送数据：JSON 文本帧（keep_alive/pong/error/action ack 等控制消息）
   * 或 yjs:update 二进制帧（Uint8Array，SP-A4 线协议，见 protocol/update-frame.ts）
   */
  send(data: string | Uint8Array): void;
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
  /**
   * 在途会话同步请求（create_session/load_session/resume_session）的 rpcId 集合。
   * JSON-RPC 响应帧只有 id 无 method，relay 的会话同步 result 分支无法区分响应来源；
   * rename/delete 等其他携带 sessionId 的响应不得进入该分支（否则 registry 活跃会话
   * 被 clobber、绑定校验丢弃当前会话增量、误开回放窗口）。请求出口登记、响应消费后删除。
   */
  pendingSessionSyncIds?: Set<number | string>;
  /**
   * 在途 prompt 请求（send_prompt）的 rpcId 集合。Agent 子进程死亡等场景下 acp-link
   * 以 JSON-RPC error 响应（-32000 No active session / -32603 Prompt failed）拒绝
   * prompt，该错误无法归一化为终态事件，若不收敛则 turn 永久卡 accepting、前端
   * loading 永不消失。仅登记过的 prompt id 匹配时收敛 turn_failed，其余错误帧
   * 静默丢弃（不派发终态事件）。
   */
  pendingPromptIds?: Set<number | string>;
  /**
   * 在途 prompt 请求的 turnId 登记（rpcId → turnId）。聚合层按 active turn 归位
   * 增量/终态，不校验事件归属 turnId——连续 prompt 时前一条的终态会提前终结
   * 后一条的 turn（后一条增量全被丢弃）。终态事件按此登记附加 turnId 后，
   * 聚合层能区分终态归属，stale turn 的迟到终态不再误伤新 turn。
   */
  pendingPromptTurns?: Map<number | string, string>;
  /**
   * 在途 prompt 的超时定时器（rpcId → timer）。registerPendingPrompt 登记时启动，
   * 到点时若 agent 全程静默（lastInboundAt 距今 ≥ PROMPT_TIMEOUT_MS）收敛 turn_failed，
   * 有业务帧则重排等待；JSON-RPC result/error 消费登记时清除（见 clearPendingPromptTimeout）。
   */
  pendingPromptTimeouts?: Map<number | string, ReturnType<typeof setTimeout>>;
  /** 最近一次收到 Agent 业务入站消息的时间戳（ms），流式输出期间持续刷新；保活帧不更新 */
  lastInboundAt?: number;
  /** session/list 轮询因 status 门禁未置位而连续跳过的次数（连续 3 次告警，成功后清零） */
  sessionListSkipCount?: number;
  /**
   * load_session 回放窗口截止时间戳（ms）。load_session 成功后短暂开启，
   * 期间到达的无 turnId user_message 由 relay-event-handler 分配回放 turnId，
   * 使 Agent 全量回放的历史增量能够投影为时间线（无持久化快照时的历史恢复来源）；
   * 窗口外到达的无 turnId user_message（实时回显）保持原语义丢弃。
   */
  replayWindowUntil: number | null;
  /**
   * 回放窗口内合成/分配的回放 turnId（turn_replay_ 前缀，窗口内最后一个）。
   * 回放流无终态信号（unstable_resumeSession 只回放 chunk 帧），不收敛则回放
   * turn 永久卡 running、前端一直显示输出中；窗口到期定时器按此 id 收敛 completed。
   * 期间用户发出新消息（active turn 已被替换）时聚合层按 turnId 归属拒绝该终态，
   * 不误伤新 turn。
   */
  replayTurnId?: string | null;
  /** 回放窗口到期定时器：到期收敛 replayTurnId 对应回放 turn 并重置窗口 */
  replayWindowTimer?: ReturnType<typeof setTimeout> | null;
  /**
   * 回放窗口开启瞬间"Chat Doc 是否已有时间线内容"的判定缓存（窗口内固定，不实时
   * 检查）。合成投影本身会写 Chat Doc，实时检查会把回放自己写入的内容误判为
   * "重连前已有内容"、挡住窗口内后续回放帧（多轮历史回放只投影第一条）。窗口
   * 开启时判定一次：空 doc（冷启动/切换清空）→ 允许合成；有内容（重连）→ 跳过。
   */
  replaySkipSynthesis?: boolean;
}

/**
 * 清除指定 rpcId 的 prompt 超时定时器。
 * 在 JSON-RPC result（成功）/error（拒绝）消费登记时调用，防止定时器到点后
 * 对已正常完成的 prompt 误收敛；超时收敛路径自身也会消费登记并清除定时器。
 */
export function clearPendingPromptTimeout(shared: SharedRelay, rpcId: number | string): void {
  const timer = shared.pendingPromptTimeouts?.get(rpcId);
  if (timer) {
    clearTimeout(timer);
    shared.pendingPromptTimeouts?.delete(rpcId);
  }
}
