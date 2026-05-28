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
}

/** Transport — 连接管理 + 会话创建 */
export interface Transport {
  connect(agentId: string, options?: { cwd?: string; spawnedEnvIds?: Set<string> }): Promise<AgentSession>;
  disconnect?(): Promise<void>;
  isReady?(): boolean;
}
