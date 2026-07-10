import type { PaginatedResponse } from "./request";
import { request } from "./request";

export interface HttpDefinition {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string> | null;
  body?: string | null;
}

export interface AgentDefinition {
  prompt: string;
}

export interface TaskV2Info {
  id: string;
  name: string;
  description: string | null;
  cron: string;
  timezone: string | null;
  enabled: boolean;
  timeoutSeconds: number;
  agentId: string | null;
  type: "http" | "agent";
  definition: HttpDefinition | AgentDefinition;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskV2CreateBody {
  name: string;
  description?: string;
  cron: string;
  timezone?: string;
  timeoutSeconds: number;
  type: "http" | "agent";
  agentId?: string;
  definition: HttpDefinition | AgentDefinition;
}

export type TaskV2UpdateBody = Partial<TaskV2CreateBody>;

export interface ExecutionLogInfo {
  id: string;
  taskId: string;
  status: "success" | "failed" | "timeout" | "skipped";
  triggeredBy: "cron" | "manual";
  duration: number | null;
  resultSummary: string | null;
  skipReason: string | null;
  error: string | null;
  createdAt: number;
}

export const taskV2Api = {
  list: (query?: { page?: number; pageSize?: number; keyword?: string; type?: string; agentId?: string }) =>
    request<PaginatedResponse<TaskV2Info>>("/web/tasks/v2", { query }),

  get: (id: string) => request<TaskV2Info>("/web/tasks/v2/:id", { params: { id } }),

  create: (body: TaskV2CreateBody) => request<TaskV2Info>("/web/tasks/v2", { method: "POST", body }),

  update: (id: string, body: TaskV2UpdateBody) =>
    request<TaskV2Info>("/web/tasks/v2/:id", { method: "PUT", params: { id }, body }),

  del: (id: string) => request<void>("/web/tasks/v2/:id", { method: "DELETE", params: { id } }),

  toggle: (id: string) =>
    request<{ id: string; enabled: boolean }>("/web/tasks/v2/:id/toggle", { method: "POST", params: { id } }),

  trigger: (id: string) =>
    request<{ status: string; duration: number; resultSummary?: string }>("/web/tasks/v2/:id/trigger", {
      method: "POST",
      params: { id },
    }),

  logs: (id: string, query?: { page?: number; pageSize?: number }) =>
    request<PaginatedResponse<ExecutionLogInfo>>("/web/tasks/v2/:id/logs", {
      params: { id },
      query,
    }),

  clearLogs: (id: string) => request<void>("/web/tasks/v2/:id/logs", { method: "DELETE", params: { id } }),
};
