/**
 * tasks.ts — 定时任务域 API 模块
 *
 * 封装定时任务的 CRUD 操作，统一通过 request() 与后端 /web/tasks 通信。
 */

import type { TaskInfo } from "../types";
import type { PaginatedResponse } from "./request";
import { request } from "./request";

/** 创建任务请求体 */
export interface TaskCreateBody {
  name: string;
  cronExpression: string;
}

/** 更新任务请求体（部分字段可选） */
export type TaskUpdateBody = Partial<TaskCreateBody>;

export const taskApi = {
  /** 分页查询任务列表，支持关键词搜索 */
  list: (query?: { page?: number; pageSize?: number; keyword?: string }) =>
    request<PaginatedResponse<TaskInfo>>("/web/tasks", { method: "GET", query }),

  /** 根据 ID 获取单个任务详情 */
  get: (id: string) => request<TaskInfo>("/web/tasks/:id", { method: "GET", params: { id } }),

  /** 创建新的定时任务 */
  create: (body: TaskCreateBody) => request<TaskInfo>("/web/tasks", { method: "POST", body }),

  /** 更新已有定时任务 */
  update: (id: string, body: TaskUpdateBody) =>
    request<TaskInfo>("/web/tasks/:id", { method: "PUT", params: { id }, body }),

  /** 删除定时任务 */
  del: (id: string) => request<void>("/web/tasks/:id", { method: "DELETE", params: { id } }),
};
