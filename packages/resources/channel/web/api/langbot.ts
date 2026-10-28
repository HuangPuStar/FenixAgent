/**
 * LangBot 控制面域模块（`/web/channels/langbot`）。
 *
 * 类型逐字段对应 `packages/resources/channel/src/server/schemas/langbot.schema.ts` 的响应 schema：
 * 后端以响应白名单约束字段，`config` 永不出现在响应里，因此这里也不能声明它；Bot 的 `lastError`
 * 与 `enabled` 同样没有进入控制面视图，页面不得补出这些幻影字段（规格 §7.3）。
 */

import { request } from "@fenix/web-runtime/api/request";

/** LangBot 服务探测结果；配置缺失时后端返回 503，由 `unwrap` 转成 `ApiError`。 */
export interface LangBotStatus {
  reachable: boolean;
  version: string | null;
  edition: string | null;
  wizardStatus: string | null;
}

/** Bot 与平台通道的并集行；`channelId` 为空表示只有 LangBot 侧记录。 */
export interface LangBotBot {
  botUuid: string | null;
  name: string;
  adapter: string | null;
  channelId: string | null;
  channelName: string | null;
  status: string | null;
  boundRouteCount: number;
  missingInLangbot: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export type LangBotChatType = "person" | "group";

/** 一行路由规则；`chatId` 为空表示该聊天类型的通配路由。 */
export interface LangBotRoute {
  id: string;
  channelId: string;
  chatType: string;
  chatId: string | null;
  agentConfigId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 只读会话映射；`sessionId` 已由服务端脱敏。 */
export interface LangBotConversation {
  id: string;
  channelId: string;
  chatType: string;
  chatId: string;
  agentConfigId: string;
  sessionId: string;
  lastEventAt: string | null;
  lastReplyAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LangBotConversationPage {
  items: LangBotConversation[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LangBotCreateBotInput {
  name: string;
  adapter: string;
  config: Record<string, unknown>;
}

/** 未提供的字段保持不变；`config` 一旦提供就是在 LangBot 上整体替换。 */
export interface LangBotUpdateBotInput {
  name?: string;
  adapter?: string;
  config?: Record<string, unknown>;
}

export interface LangBotTestSendInput {
  targetType: LangBotChatType;
  targetId: string;
  text: string;
}

export interface LangBotCreateRouteInput {
  channelId: string;
  chatType: LangBotChatType;
  chatId?: string;
  agentConfigId: string;
  enabled?: boolean;
}

/** `chatId: null` 表示改为通配路由。 */
export interface LangBotUpdateRouteInput {
  chatType?: LangBotChatType;
  chatId?: string | null;
  agentConfigId?: string;
  enabled?: boolean;
}

export interface LangBotConversationQuery {
  page: number;
  pageSize: number;
  channelId?: string;
}

/** 删除与测试发送的成功信封数据。 */
export interface LangBotOkResult {
  ok: true;
}

export const langbotApi = {
  status: () => request<LangBotStatus>("/web/channels/langbot/status", { method: "GET" }),

  listBots: () => request<LangBotBot[]>("/web/channels/langbot/bots", { method: "GET" }),

  getBot: (botUuid: string) =>
    request<LangBotBot>("/web/channels/langbot/bots/:botUuid", { method: "GET", params: { botUuid } }),

  createBot: (body: LangBotCreateBotInput) =>
    request<LangBotBot>("/web/channels/langbot/bots", { method: "POST", body }),

  updateBot: (botUuid: string, body: LangBotUpdateBotInput) =>
    request<LangBotBot>("/web/channels/langbot/bots/:botUuid", { method: "PATCH", params: { botUuid }, body }),

  deleteBot: (botUuid: string) =>
    request<LangBotOkResult>("/web/channels/langbot/bots/:botUuid", { method: "DELETE", params: { botUuid } }),

  testSend: (botUuid: string, body: LangBotTestSendInput) =>
    request<LangBotOkResult>("/web/channels/langbot/bots/:botUuid/send", {
      method: "POST",
      params: { botUuid },
      body,
    }),

  listRoutes: (channelId?: string) =>
    request<LangBotRoute[]>("/web/channels/langbot/routes", {
      method: "GET",
      query: channelId ? { channelId } : undefined,
    }),

  createRoute: (body: LangBotCreateRouteInput) =>
    request<LangBotRoute>("/web/channels/langbot/routes", { method: "POST", body }),

  updateRoute: (id: string, body: LangBotUpdateRouteInput) =>
    request<LangBotRoute>("/web/channels/langbot/routes/:id", { method: "PATCH", params: { id }, body }),

  deleteRoute: (id: string) =>
    request<LangBotOkResult>("/web/channels/langbot/routes/:id", { method: "DELETE", params: { id } }),

  listConversations: (query: LangBotConversationQuery) =>
    request<LangBotConversationPage>("/web/channels/langbot/conversations", { method: "GET", query }),
};
