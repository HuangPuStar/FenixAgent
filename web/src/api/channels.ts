/**
 * channels.ts — IM 通道域 API 模块
 *
 * 封装 IM 通道的 provider 查询、Hermes 状态查询、绑定关系 CRUD。
 * 采用 RESTful 风格，统一通过 request() 与后端 /web/channels/* 通信。
 */

import { request } from "./request";

/** 通道绑定记录 */
interface ChannelBinding {
  id: string;
  platform: string;
  chatId: string;
  agentId: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 通道 Provider 描述符 */
interface ChannelProviderDescriptor {
  id: string;
  name: string;
  type: string;
}

/** 通道绑定列表响应 */
export type ChannelBindingListResponse = ChannelBinding[];

/** 通道 Provider 列表响应 */
export type ChannelProviderListResponse = ChannelProviderDescriptor[];

/** 创建通道绑定请求体 */
export interface CreateChannelBindingRequest {
  platform: string;
  chatId: string;
  agentId: string;
  enabled?: boolean;
}

/** 创建通道绑定响应 */
export type CreateChannelBindingResponse = ChannelBinding;

/** 删除通道绑定响应 */
export type DeleteChannelBindingResponse = Record<string, unknown>;

/** Hermes 推送服务连接状态 */
export interface HermesStatus {
  connected: boolean;
  url?: string;
}

/** 更新通道绑定响应 */
export type UpdateChannelBindingResponse = ChannelBinding;

export const channelApi = {
  /** 获取所有可用的 IM 通道 Provider 列表 */
  listProviders: () => request<ChannelProviderListResponse>("/web/channels/providers", { method: "GET" }),

  /** 查询 Hermes 消息推送服务连接状态 */
  hermesStatus: () => request<HermesStatus>("/web/channels/hermes-status", { method: "GET" }),

  /** 获取当前组织下所有的通道绑定关系 */
  listBindings: () => request<ChannelBindingListResponse>("/web/channels/bindings", { method: "GET" }),

  /** 创建新的通道绑定（将 Agent 路由到指定 IM 通道） */
  createBinding: (body: CreateChannelBindingRequest) =>
    request<ChannelBinding>("/web/channels/bindings", { method: "POST", body }),

  /** 删除指定通道绑定 */
  deleteBinding: (params: { id: string }) =>
    request<DeleteChannelBindingResponse>("/web/channels/bindings/:id", {
      method: "DELETE",
      params,
    }),

  /** 更新已有通道绑定（支持部分字段更新） */
  updateBinding: (
    params: { id: string },
    body: Partial<Pick<ChannelBinding, "platform" | "chatId" | "agentId" | "enabled">>,
  ) =>
    request<UpdateChannelBindingResponse>("/web/channels/bindings/:id", {
      method: "PUT",
      params,
      body,
    }),
};
