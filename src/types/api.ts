/** API 请求/响应类型定义 */

// --- Environment ---

export interface EnvironmentResponse {
  id: string;
  machine_name: string | null;
  directory: string | null;
  branch: string | null;
  status: string;
  username: string | null;
  last_poll_at: number | null;
  worker_type?: string;
  capabilities?: Record<string, unknown> | null;
}

export interface RegisterEnvironmentRequest {
  machine_name?: string;
  directory?: string;
  branch?: string;
  git_repo_url?: string;
  max_sessions?: number;
  worker_type?: string;
  bridge_id?: string;
  capabilities?: Record<string, unknown>;
  metadata?: { worker_type?: string };
}

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

export interface CreateCodeSessionRequest {
  title?: string;
  source?: string;
  username?: string;
}

export interface WorkResponse {
  id: string;
  type: string;
  environment_id: string;
  state: string;
  data: {
    type: string;
    id: string;
  };
  secret: string;
  created_at: string;
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
  agentConfigId?: string;
}

export interface UpdateEnvironmentWebRequest {
  name?: string;
  description?: string;
  workspacePath?: string;
  agentConfigId?: string | null;
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
