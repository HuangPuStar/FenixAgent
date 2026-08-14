import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import type { WsConnection } from "../../ws-types";

export type RelayMessage = EngineRelayMessage;

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
   * prompt，该错误若不收敛则前端 loading 永不消失。按 id 匹配登记以区分
   * set_session_model 等命令回执（保持既有语义）。
   */
  pendingPromptIds?: Set<number | string>;
  /** session/list 轮询因 status 门禁未置位而连续跳过的次数（连续 3 次告警，成功后清零） */
  sessionListSkipCount?: number;
}
