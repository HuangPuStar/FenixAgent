import type { DocManager } from "../state/doc-manager";
import type { ProjectionDocs } from "../types";
import type { SyncConnection, UserInputRequestHandle, UserInputRequestKind } from "./connection-types";

/** 连接在会话频道上的绑定上下文（多标签页共享同一 rcsSessionId 的频道状态） */
export interface SessionConnection {
  userId: string;
  /**
   * 环境属主（gateway 从已认证 environment 注入）。与 userId 不一致 = 只读观察者：
   * steer 等会话写操作必须拒绝，缺省（旧装配）时不判定。
   */
  ownerUserId?: string;
  agentId: string;
  instanceId: string;
  /** relay 建立时捕获的服务端运行代次，缺失时禁止跨连接复用确认。 */
  runtimeIdentity?: string;
  /** 读取当前物理连接的 Agent 连续性，子进程断开后变化。 */
  getSessionContinuity?: () => object | undefined;
  rcsSessionId: string;
  acpSessionId: string | null;
  /** Agent status 是否已到达（确认 ACP 初始化完成，list_sessions 守卫） */
  agentStatusReceived: boolean;
  /** 是否已执行过至少一次 load_session（区分重连首次加载 vs 后续正常切换） */
  sessionLoaded: boolean;
  workspacePath: string | null;
  /** 客户端最近一次 keep_alive 时间戳（宿主侧连接活动观测用，控制面不读取） */
  lastClientKeepalive?: number;
  /** 发送 RPC 到 relay（测试中为记录型 fake） */
  sendToRelay: (message: Record<string, unknown>) => Promise<void> | void;
  /** JSON-RPC id 递增计数器，保证同一 instance 下生成唯一 id */
  getNextRpcId: () => number;
  /**
   * 登记在途会话同步请求（create/load/resume）的 rpcId：响应到达时 relay 的
   * 会话同步 result 分支按 id 校验（JSON-RPC 响应无 method 字段，rename/delete
   * 等其他携带 sessionId 的响应不得劫持该分支）。可选注入，宿主由 gateway 提供。
   */
  registerSessionSyncRpcId?: (rpcId: number | string, targetSessionId?: string) => void;
  /**
   * 登记在途 prompt 请求（send_prompt）的 rpcId 与对应 turnId：Agent 子进程死亡时
   * acp-link 以 JSON-RPC error 响应拒绝 prompt，relay 按 id 匹配该登记并收敛
   * turn_failed（防止 loading 永久卡死）；turnId 随终态事件回传聚合层，使终态
   * 归属校验（连续 prompt 时旧 turn 的迟到终态不误伤新 turn）成为可能。
   * 可选注入，宿主由 gateway 提供。
   */
  registerPendingPrompt?: (rpcId: number | string, turnId: string | undefined) => void;
  /** 登记会话变更响应；relay 断开或超时时以 false 完成。 */
  awaitSessionMutation?: (rpcId: number | string) => {
    completed: Promise<boolean>;
    cancel: () => void;
    isCurrent?: () => boolean;
  };
  /** 新同步协议连接级运行时；仅用于后端单写用户消息。 */
  syncConnection?: SyncConnection;
  /**
   * 登记在途 steer（session/input/*）请求：JSON-RPC 响应帧只有 id 无 method，
   * relay 的队列响应分支按登记收敛（prompt / 会话同步同理各按自己的登记寻址）。
   * 可选注入，宿主由 gateway 提供；未注入时 steer action 以 AGENT_UNAVAILABLE 失败。
   */
  awaitUserInputRequest?: (
    rpcId: number | string,
    kind: UserInputRequestKind,
    timeoutMs: number,
  ) => UserInputRequestHandle | undefined;
  /**
   * 登记 create_session 的创建回执：resolve 为 Agent 实际创建出的 session id
   * （超时 / relay 断开 / agent 拒绝时为 null）。可选注入，宿主由 gateway 提供。
   */
  awaitSessionCreation?: (rpcId: number | string) => {
    completed: Promise<string | null>;
    cancel: () => void;
    isCurrent?: () => boolean;
  };
}

export interface SessionChannelDependencies {
  docManager: DocManager;
  /** 新 ACP session 创建前刷新当前实例的 workspace 配置与 Skills。 */
  refreshInstanceEnvironment?: (connection: SessionConnection) => Promise<void>;
  /** 新投影交换后重绑 broadcaster 并向同 RCS 会话全部客户端发送 replace frame。 */
  replaceProjection: (projection: ProjectionDocs) => void;
  /** 会话切换后同步 acpSessionId 到同一 instance+user 的所有客户端 */
  syncSessionId: (connection: SessionConnection, newSessionId: string) => void;
  /**
   * 用户消息写入唯一同步入口：按 rcsSessionId 扇出到该会话所有同步连接。
   * 发起动作的旧 socket 通常没有 sync runtime，不能只写它自己的连接。
   */
  publishUserMessage?: (rcsSessionId: string, turnId: string, text: string) => void;
  reportError: (message: string, error: unknown) => void;
  /** 公开错误安全事件 sink；不得记录原始异常或 Action payload。 */
  reportLog?: (message: string) => void;
  /** 每 rcsSessionId 有界队列上限（透传给 CommandCoordinator） */
  maxPendingPerSession?: number;
  /** 取消超时（毫秒）：cancel 后 Agent 未确认时 turn 收敛为 interrupted，默认 10s */
  cancelTimeoutMs?: number;
  /** 权限请求超时（毫秒）：超过 expiresAt 未响应时迁移 pending → expired，默认 5min */
  permissionTimeoutMs?: number;
  /** steer（session/input/*）等待 peri 回执的上限（毫秒），缺省 DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS */
  userInputQueueTimeoutMs?: number;
  /**
   * 会话级 MCP 条目（通道 B）：每次 `session/new|load|resume` 前解析一次。
   *
   * 条目只进 ACP 消息、不落盘，token 因此可以短 TTL。解析失败由 SessionChannel 记录并降级为
   * 「本次不注入」，不能让云盘凭据问题阻断用户建会话。
   */
  sessionMcpServers?: (connection: SessionConnection) => Promise<readonly Record<string, unknown>[] | undefined>;
}
