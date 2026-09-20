/** API 请求/响应类型定义 */

// --- Environment ---
// 环境（worker）注册的请求 / 响应体已随 1.4 的 W1 类型搬家收回其 owner
// `@fenix/agent-runtime/server`（`EnvironmentResponse` / `RegisterEnvironmentRequest`）：它们描述的是该包的
// 注册入口与响应映射的输入输出，宿主只是转发，实测宿主零消费方。

export interface SessionSummaryResponse {
  id: string;
  title: string | null;
  status: string;
  username: string | null;
  updated_at: number;
}

export interface SessionResponse {
  id: string;
  environment_id: string | null;
  agent_name: string | null;
  title: string | null;
  status: string;
  source: string;
  username: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateSessionRequest {
  environment_id?: string;
  title?: string;
  source?: string;
  username?: string;
}

export interface AutomationStateResponse {
  enabled: boolean;
  phase: "standby" | "sleeping" | null;
  next_tick_at: number | null;
  sleep_until: number | null;
}

// --- Error ---

export interface ErrorResponse {
  error: {
    type: string;
    message: string;
  };
}

// --- Environment Registration (Web UI) ---

export interface RegisterEnvironmentWebRequest {
  name: string;
  description?: string;
  workspacePath: string;
  agentConfigId: string;
}

export interface UpdateEnvironmentWebRequest {
  name?: string;
  description?: string;
  workspacePath?: string;
  agentConfigId?: string;
}

export interface EnvironmentWebResponse {
  id: string;
  name: string;
  description: string | null;
  workspace_path: string;
  agent_config_id: string | null;
  status: string;
  machine_name: string | null;
  branch: string | null;
  secret?: string;
  last_poll_at: number | null;
  created_at: number;
  updated_at: number;
}
