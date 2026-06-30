/**
 * tasks.ts — 定时任务域 API 模块
 *
 * 封装定时任务的 CRUD、启停、触发、日志等操作，统一通过 request() 与后端 /web/tasks 通信。
 */

import type { PaginatedResponse } from "./request";
import { request } from "./request";

/** 后端返回的任务详情 */
export interface TaskInfo {
  id: string;
  name: string;
  description: string | null;
  cron: string;
  timezone: string | null;
  enabled: boolean;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  body: string | null;
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

/** 创建任务请求体 */
export interface TaskCreateBody {
  name: string;
  description?: string;
  cron: string;
  timezone?: string | null;
  url: string;
  method?: string;
  headers?: string | null;
  body?: string | null;
}

/** 更新任务请求体（部分字段可选，启用状态可单独切换） */
export type TaskUpdateBody = Partial<TaskCreateBody> & { enabled?: boolean };

export const taskApi = {
  /** 获取任务列表（返回扁平数组） */
  list: (query?: { page?: number; pageSize?: number; keyword?: string }) =>
    request<TaskInfo[]>("/web/tasks", { method: "GET", query }),

  /** 根据 ID 获取单个任务详情 */
  get: (id: string) => request<TaskInfo>("/web/tasks/:id", { method: "GET", params: { id } }),

  /** 创建新的定时任务 */
  create: (body: TaskCreateBody) => request<TaskInfo>("/web/tasks", { method: "POST", body }),

  /** 更新已有定时任务 */
  update: (id: string, body: TaskUpdateBody) =>
    request<TaskInfo>("/web/tasks/:id", { method: "PUT", params: { id }, body }),

  /** 删除定时任务。后端返回 { success: true }（无 data 字段）。 */
  del: (id: string) => request<{ success: true }>("/web/tasks/:id", { method: "DELETE", params: { id } }),

  /** 切换任务启用/禁用状态，返回切换后的 { id, enabled } */
  toggle: (id: string) =>
    request<{ id: string; enabled: boolean }>("/web/tasks/:id/toggle", { method: "POST", params: { id } }),

  /** 手动触发一次任务执行，返回本次执行日志 */
  trigger: (id: string) => request<ExecutionLogInfo>("/web/tasks/:id/trigger", { method: "POST", params: { id } }),

  /** 分页获取任务执行日志 */
  logs: (id: string, query?: { page?: number; pageSize?: number }) =>
    request<PaginatedResponse<ExecutionLogInfo>>("/web/tasks/:id/logs", { method: "GET", params: { id }, query }),

  /** 清空任务所有执行日志。后端返回 { success: true }（无 data 字段）。 */
  clearLogs: (id: string) => request<{ success: true }>("/web/tasks/:id/logs", { method: "DELETE", params: { id } }),
};
