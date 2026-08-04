/**
 * Transport 接口 — Agent 通信的抽象层。
 *
 * AgentExecutor 通过此接口与 Environment 的 Agent 通信，
 * 不依赖具体的 WebSocket/HTTP 实现。
 */

/** Agent 请求参数 */
export interface AgentRequest {
  prompt: string;
  signal?: AbortSignal;
}

/** 会话流中的单条消息 */
export interface AgentMessage {
  role: "assistant" | "tool_call" | "tool_result" | "user";
  content: string;
  /** tool_call / tool_result 的工具名 */
  tool_name?: string;
}

/** Agent 响应结果 */
export interface AgentResponse {
  /** 简化后的文本（去掉 tool_call/tool_result，拼接 assistant content） */
  stdout: string;
  exit_code: number;
  tokens?: { input: number; output: number };
  model?: string;
  latency_ms?: number;
  /** 完整会话流 */
  messages: AgentMessage[];
}

/** Agent 会话 — 单次连接内可多次执行请求 */
export interface AgentSession {
  execute(request: AgentRequest): Promise<AgentResponse>;
  /**
   * 释放本次会话持有的资源（如注册的消息监听器）。可选：由 Transport 实现决定是否实现。
   * 注意：不承诺关闭底层连接或销毁实例——复用语义由 Transport 实现负责。
   * 设计原因（C-P2.3）：engine 对每次 connect 产生的会话负责释放，避免
   * 同实例复用场景下每次 run 累积一个死 listener。
   */
  dispose?(): Promise<void>;
}

/** Transport — 连接管理 + 会话创建 */
export interface Transport {
  connect(
    agentId: string,
    options?: {
      cwd?: string;
      /** 本次运行实际启动的实例 ID（复用不记录；供宿主清理） */
      spawnedInstanceIds?: Set<string>;
      /**
       * 工作流触发者 userId（C-P2.5）：透传给宿主 ensureRunning 的配额桶归属。
       * 未传（如 webhook 匿名触发）时由宿主回退 "system"。
       */
      userId?: string;
    },
  ): Promise<AgentSession>;
  disconnect?(): Promise<void>;
  isReady?(): boolean;
}
