/**
 * tasks.ts — 定时任务域 API 模块
 *
 * 封装定时任务的 CRUD、启停、触发、日志等操作，统一通过 request() 与后端 /web/tasks/v2 通信。
 */

import type { PaginatedResponse } from "./request";
import { request } from "./request";

/** HTTP 任务定义 */
export interface HttpDefinition {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Agent 任务定义 */
export interface AgentDefinition {
  prompt: string;
}

/** 后端返回的任务详情 */
export interface TaskV2Info {
  id: string;
  name: string;
  description: string | null;
  cron: string;
  timezone: string | null;
  enabled: boolean;
  timeoutSeconds: number;
  type: string;
  agentId: string | null;
  definition: HttpDefinition | AgentDefinition | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 后端返回的执行日志详情 */
export interface ExecutionLogInfo {
  id: string;
  taskId: string;
  status: string;
  error: string | null;
  duration: number | null;
  triggeredBy: string;
  skipReason: string | null;
  resultSummary: string | null;
  createdAt: number;
}

/** 创建 HTTP 任务请求体 */
export interface HttpTaskCreateBody {
  name: string;
  description?: string;
  cron: string;
  timezone?: string | null;
  timeoutSeconds?: number;
  type: "http";
  definition: HttpDefinition;
}

/** 创建 Agent 任务请求体 */
export interface AgentTaskCreateBody {
  name: string;
  description?: string;
  cron: string;
  timezone?: string | null;
  timeoutSeconds?: number;
  type: "agent";
  agentId: string;
  definition: AgentDefinition;
}

export type TaskV2CreateBody = HttpTaskCreateBody | AgentTaskCreateBody;

/** 更新任务请求体 */
export type TaskV2UpdateBody = Partial<Omit<HttpTaskCreateBody, "type">> & { enabled?: boolean };

export const taskApi = {
  /** 获取任务列表（返回扁平数组） */
  list: (query?: { page?: number; pageSize?: number; keyword?: string }) =>
    request<TaskV2Info[]>("/web/tasks/v2", { method: "GET", query }),

  /** 根据 ID 获取单个任务详情 */
  get: (id: string) => request<TaskV2Info>("/web/tasks/v2/:id", { method: "GET", params: { id } }),

  /** 创建新的定时任务 */
  create: (body: TaskV2CreateBody) => request<TaskV2Info>("/web/tasks/v2", { method: "POST", body }),

  /** 更新已有定时任务 */
  update: (id: string, body: TaskV2UpdateBody) =>
    request<TaskV2Info>("/web/tasks/v2/:id", { method: "PUT", params: { id }, body }),

  /** 删除定时任务。 */
  del: (id: string) => request<void>("/web/tasks/v2/:id", { method: "DELETE", params: { id } }),

  /** 切换任务启用/禁用状态，返回切换后的 { id, enabled } */
  toggle: (id: string) =>
    request<{ id: string; enabled: boolean }>("/web/tasks/v2/:id/toggle", { method: "POST", params: { id } }),

  /** 手动触发一次任务执行，返回本次执行日志 */
  trigger: (id: string) =>
    request<{ status: string; duration: number; error?: string; resultSummary?: string }>("/web/tasks/v2/:id/trigger", {
      method: "POST",
      params: { id },
    }),

  /** 分页获取任务执行日志 */
  logs: (id: string, query?: { page?: number; pageSize?: number }) =>
    request<PaginatedResponse<ExecutionLogInfo>>("/web/tasks/v2/:id/logs", { method: "GET", params: { id }, query }),

  /** 清空任务所有执行日志。 */
  clearLogs: (id: string) => request<void>("/web/tasks/v2/:id/logs", { method: "DELETE", params: { id } }),
};
