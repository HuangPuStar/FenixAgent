// packages/chat-channel/src/channel/connection-types.ts
// 连接层类型（迁移自 src/transport/relay/yjs-frontend/types.ts，语义原样保留）。
//
// ClientConnection / SharedRelay 承载多标签页共享 relay handle 的引用计数语义：
// 同一 instanceId + userId 的多个前端连接共享同一 SharedRelay，引用计数归零才释放。
// WsConnection 为最小 WebSocket 抽象（纯接口，无框架依赖），宿主侧适配注入。

import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import type { PublicErrorType } from "../public-error";
import type { SyncTransportDiagnostics } from "../sync/runtime/scope-runtime";

export type RelayMessage = EngineRelayMessage;

/** steer（session/input/*）请求类别：只用于诊断与响应形状判定 */
export type UserInputRequestKind = "snapshot" | "enqueue" | "dispatch" | "takeback";

/**
 * 在途 steer 请求的收敛结果。失败一律携带可直接回给浏览器的公开错误类型：
 * 队列操作不接受静默失败，也不做自动重试（用户看到提示后手动重试即可）。
 * `not_withdrawable`：peri 回执成功但未真撤出（项已被投递，见 user-input-queue-wire.ts）。
 */
export type UserInputRequestOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "rejected" | "timeout" | "relay_closed" | "not_withdrawable";
      publicErrorType: PublicErrorType;
    };

/** 在途 steer 请求的等待句柄（命令执行与能力补拉共用） */
export interface UserInputRequestHandle {
  completed: Promise<UserInputRequestOutcome>;
  cancel: () => void;
}

/** 在途 steer 请求登记条目：relay 响应侧（relay-event-handler）按 rpcId settle */
export interface PendingUserInputRequest {
  kind: UserInputRequestKind;
  settle: (outcome: UserInputRequestOutcome) => void;
}

/**
 * load_session 回放窗口时长（ms）。load/resume 的 RPC 转发时开启（早于 Agent 历史
 * 回放流到达，JSON-RPC result 分支兜底重置），窗口内且 Chat Doc 无时间线内容时，
 * 到达的 Agent 历史回放（无头增量流 / 无 turnId user_message）由 relay-event-handler
 * 补全 turn 上下文投影时间线——无持久化快照时历史恢复的唯一来源；窗口外或
 * doc 已有内容（重连跳过回放语义）保持原语义由聚合层拒绝。
 */
export const REPLAY_WINDOW_MS = 10_000;

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
  /** socket 待发送字节真值；宿主适配器提供，缺省按 0 处理（与旧链路一致）。 */
  readonly bufferedAmount?: number;
}

/** 新聊天同步协议的装配配置（开关关闭时旧链路逐字节不变）。 */
export interface ChatSyncProtocolConfig {
  readonly enabled: boolean;
  readonly sealGraceMs: number;
  readonly retireGraceMs: number;
}

/**
 * 单个连接的新同步运行时端口。
 *
 * 每条已认证连接持有独立 runtime / 内存 store；这里只暴露连接层需要的动作，协议规则留在
 * `sync/runtime/**`。所有方法由实现方自行捕获错误，连接层不等待其异步完成。
 */
export interface SyncConnection {
  /** 入站二进制帧（已由连接层按 `{` 首字节判定为新协议）。 */
  onInboundBytes(bytes: Uint8Array): Promise<void>;
  /** 旧投影路径已处理过的规范化 ACP 事件；trusted turnId 缺失时实现方不产事件。 */
  acceptNormalizedEvent(event: {
    readonly type: string;
    readonly update: Record<string, unknown>;
    readonly content?: Record<string, unknown> | null;
    readonly turnId?: string | null;
  }): void;
  /** 后端单写用户消息（turnId 来自 registerUserMessage 的可信绑定）。 */
  acceptUserMessage(turnId: string, text: string): void;
  /** 连接窗口快照（观测/测试）；不改变账目。 */
  diagnostics?(): SyncTransportDiagnostics;
  /** live ingress 失败计数与显式停止状态；连接层按需观测，不影响投影。 */
  ingressDiagnostics?(): {
    readonly total: number;
    readonly lastCode: string | null;
    readonly stopped: boolean;
  };
  /** 连接关闭时释放 runtime、定时器与内存投影。 */
  dispose(): void;
}

/** 单个前端 WebSocket 客户端在连接生命周期内的全部状态 */
export interface ClientConnection {
  ws: WsConnection;
  userId: string;
  /**
   * 环境属主（gateway 从已认证 environment 注入）。与 userId 不一致 = 只读观察者：
   * 当前 /acp/yjs 只放行属主（route 的 resolveOwnedEnvironment + authorizeEnvironment），
   * 该字段为连接层放开只读接入时的写入判定留出唯一事实来源。
   */
  ownerUserId?: string;
  agentId: string;
  relayHandle: EngineRelayHandle;
  keepalive: ReturnType<typeof setInterval>;
  instanceId: string;
  /** RCS 会话标识符 (rcs_xxx)，连接生命周期内不变 */
  rcsSessionId: string;
  /** 认证后组织标识；新同步 scope 使用，旧链路忽略。 */
  organizationId?: string;
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
  /** 新同步协议连接级运行时；开关关闭或创建失败时缺省。 */
  syncConnection?: SyncConnection;
  /** 关闭或权威换代后禁止在途 attach 把 runtime 写回。 */
  syncClosed?: boolean;
  /**
   * attach 窗口内产生的用户消息：同步连接就绪后按序补水。
   * 动作 socket 与同步 socket 分离，首 prompt 可能早于 syncConnection 挂载。
   */
  pendingSyncUserMessages?: Array<{ turnId: string; text: string }>;
  /**
   * 客户端声明该连接只消费新同步协议（`chatSync=1`）。
   *
   * 此类连接不再接收旧全量快照、旧 Doc 广播与 legacy state-vector 差量，但保留文本 action
   * （会话切换/取消/权限响应等）与同步 runtime ingress；旧客户端（无标记或 `chatSync=0`）
   * 的旧链路行为逐字节不变。
   */
  syncOnly?: boolean;
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
  /** 会话变更按 RPC id 等待 Agent 结果，避免发送成功被误报为持久化成功。 */
  pendingSessionMutations?: Map<number | string, (succeeded: boolean) => void>;
  /**
   * 在途 steer（session/input/*）请求登记：JSON-RPC 响应帧只有 id 无 method，无法区分
   * 响应来源（prompt / 会话同步 / 队列操作），必须按请求出口登记。响应到达即收敛并删除；
   * relay 断连（relay_closed / 引用计数归零释放）时全部收敛为失败，不留悬挂等待器。
   */
  pendingUserInputRequests?: Map<number | string, PendingUserInputRequest>;
  /**
   * 能力协商结果（status.capabilities 的 `peri.userInputQueue`，含 _meta 回显形状）。
   * false/未定义 = 该会话不支持待发送队列（不补拉快照，读取侧 enabled 兜底为 false）。
   */
  userInputQueueCapability?: boolean;
  /**
   * 已完成快照补拉的 ACP sessionId。队列代号与待发送项属于单个 ACP 会话：
   * 同一会话只补拉一次（status 会重复 resend），换会话按新 id 重新补拉。
   */
  userInputSnapshotSessionId?: string | null;
  /**
   * 在途 create_session 的创建回执登记（rpcId → 结算 sessionId）。
   *
   * 与 pendingSessionSyncIds 的差别是目的：后者用于「响应是否可提交投影」的身份校验，
   * 这里用于把「Agent 实际创建出的 session id」回传给发起该命令的连接（committed Ack 的
   * sessionId 字段）。分开登记是因为二者生命周期不同：身份校验对所有 create/load/resume
   * 生效，回执只有 create 需要，且必须在 supersede 的迟到响应上也结算，否则调用方
   * 永远等不到自己那次创建的结果。
   */
  pendingSessionCreations?: Map<number | string, (sessionId: string | null) => void>;
  /**
   * 最近一次发出的会话同步请求 rpcId（create/load/resume）。
   * 同一 relay 上可能同时存在多个在途会话同步请求（用户在响应到达前再次切换会话，
   * 或引导流程的自动恢复与用户点击重叠）。响应帧只有 id，无法区分「最新目标」与
   * 「已被用户切走的旧目标」：迟到的旧响应若照常提交，会把 registry 活跃会话回绑到
   * 旧 ACP session 并改写投影 sessionId，此后当前会话的回放/流式增量全部被绑定校验
   * 丢弃——客户端消息区空白。因此只有该 id 的响应才允许提交会话同步结果。
   */
  latestSessionSyncRpcId?: number | string | null;
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
  /** session/list 轮询因 status 门禁未置位而连续跳过的次数（连续 3 次告警，成功后清零） */
  sessionListSkipCount?: number;
  /**
   * load_session 回放窗口截止时间戳（ms）。load_session 成功后短暂开启，
   * 期间到达的无 turnId user_message 由 relay-event-handler 分配回放 turnId，
   * 使 Agent 全量回放的历史增量能够投影为时间线（无持久化快照时的历史恢复来源）；
   * 窗口外到达的无 turnId user_message 由 relay-event-handler 分类：文档已有同文本
   * user entry（实时回显 / 迟到回放）丢弃，否则按真异步回调建立独立条目
   * （见 callbackAssistantEntryId / callbackBindingTurnId）。
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
  /**
   * 未结束 callback 的独立 assistant 历史 entry，禁止无头 chunk 回退到主 active turn。
   * 绑定在消费端按事实校验（见下方两个代际字段），不在 openReplayWindow 里清空。
   */
  callbackAssistantEntryId?: string | null;
  /**
   * callback 绑定的代际之一：建立 `callbackAssistantEntryId` 时的 activeTurnId
   * （无活动 turn 时为 null）。无 turnId 增量到达时若当前 activeTurnId 已变，
   * 说明绑定属于上一轮/更早的回调流，必须失效——否则新 turn 的回答会被追加进
   * 遥远的旧 callback assistant entry（2026-09-24 聚合错位根因）。
   * 依赖「turn 终态后 activeTurnId 不被清空」（收敛只改状态，全仓库无置 null 调用点）：
   * 若将来引入活动 turn 清空，跨代判定会把回调流整体误判为跨代。
   */
  callbackBindingTurnId?: string | null;
  /**
   * callback 绑定的代际之二：建立 `callbackAssistantEntryId` 时的投影 generation
   * （`DocManager.getProjectionGeneration`，投影尚未完整打开时为 null）。
   * 无 turnId 增量到达时若当前 generation 与记录不一致，说明投影已被替换
   * （load/resume 换代），绑定指向的 `callback_*` entry 在新投影中不存在，
   * 继续按绑定归属会被聚合层以 "callback assistant entry not found" 拒绝（静默丢内容）。
   * 按事实判定而非在 openReplayWindow 里清空：同会话 load（刷新页面恢复）不换代、
   * 绑定仍有效，清空会让在途回调的尾部增量全部失去归属。
   */
  callbackBindingGeneration?: string | null;
}
