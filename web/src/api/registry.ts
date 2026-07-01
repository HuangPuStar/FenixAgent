/**
 * registry.ts — 机器注册表域 API 模块
 *
 * 封装机器注册表的查询操作，统一通过 request() 与后端 /web/registry/machines 通信。
 */

import type { PaginatedResponse } from "./request";
import { request } from "./request";

/** 机器注册记录 */
export interface MachineRecord {
  /** 机器唯一 ID */
  id: string;
  /** 所属组织 ID；没有组织隔离时为 null */
  organizationId: string | null;
  /** 关联用户 ID；未绑定时为 null */
  userId: string | null;
  /** 机器展示名称 */
  agentName: string;
  /** 用户自定义名称 */
  name: string | null;
  /** 机器当前状态，如 "online"、"offline" */
  status: string;
  /** 机器基础信息，如 hostname、ip、os、arch */
  machineInfo: Record<string, unknown> | null;
  /** 机器标签列表 */
  labels: string[] | null;
  /** 机器允许的最大会话数 */
  maxSessions: number;
  /** 心跳上报间隔，单位为毫秒 */
  heartbeatIntervalMs: number;
  /** 最近一次心跳时间戳，单位为秒；未收到时为 null */
  lastHeartbeatAt: number | null;
  /** 注册时间戳，单位为秒 */
  registeredAt: number;
  /** 记录创建时间戳，单位为秒 */
  createdAt: number;
  /** 记录更新时间戳，单位为秒 */
  updatedAt: number;
}

/** 注册表事件记录 */
export interface RegistryEvent {
  /** 事件唯一 ID */
  id: string;
  /** 所属机器 ID */
  machineId: string;
  /** 事件类型 */
  type: string;
  /** 事件详情负载 */
  detail: Record<string, unknown> | null;
  /** 事件创建时间戳，单位为秒 */
  createdAt: number;
}

/** 机器详情，在 MachineRecord 基础上追加最近事件列表 */
export interface MachineDetail extends MachineRecord {
  /** 该机器最近的事件列表 */
  recentEvents: RegistryEvent[];
}

/** 机器列表查询参数 */
export interface MachineListQuery {
  /** 按机器状态过滤，如 "online"、"offline" */
  status?: string;
  /** 按逗号分隔的标签过滤 */
  labels?: string;
  /** 分页大小，默认 20 */
  limit?: number;
  /** 分页偏移量，默认 0 */
  offset?: number;
}

/** 事件列表查询参数 */
export interface EventListQuery {
  /** 分页大小，默认 20 */
  limit?: number;
  /** 分页偏移量，默认 0 */
  offset?: number;
}

export const registryApi = {
  /**
   * 分页查询机器注册列表。
   *
   * 返回当前组织可见的机器列表，支持按状态和标签过滤。
   */
  list: (query?: MachineListQuery) =>
    request<PaginatedResponse<MachineRecord>>("/web/registry/machines", { method: "GET", query }),

  /**
   * 根据机器 ID 获取单台机器详情。
   *
   * 返回机器的完整信息及最近事件列表，用于机器详情面板展示。
   */
  get: (id: string) => request<MachineDetail>("/web/registry/machines/:id", { method: "GET", params: { id } }),

  /**
   * 分页查询指定机器的注册表事件历史。
   *
   * 用于状态排查和追踪，例如查看机器的上线/下线、心跳超时等历史记录。
   */
  events: (id: string, query?: EventListQuery) =>
    request<PaginatedResponse<RegistryEvent>>("/web/registry/machines/:id/events", {
      method: "GET",
      params: { id },
      query,
    }),
};
