/**
 * notifications.ts — 消息通知域 API 模块
 */

import { request } from "./request";

export interface NotificationItem {
  id: string;
  type: "platform" | "agent" | "knowledge";
  subType: string | null;
  title: string;
  content: string | null;
  targetUrl: string | null;
  metadata: Record<string, unknown> | null;
  userId: string | null;
  organizationId: string;
  isRead: boolean;
  createdAt: string;
}

export interface NotificationListResult {
  items: NotificationItem[];
  total: number;
  page: number;
  pageSize: number;
}

export const notificationApi = {
  /** 分页获取通知列表 */
  list: (query?: { page?: number; pageSize?: number; filter?: "all" | "read" | "unread" }) =>
    request<NotificationListResult>("/web/notifications", { method: "GET", query }),

  /** 获取未读数量 */
  unreadCount: () => request<{ count: number }>("/web/notifications/unread-count", { method: "GET" }),

  /** 标记单条已读 */
  markRead: (id: string) => request<void>("/web/notifications/:id/read", { method: "PUT", params: { id } }),

  /** 全部标记已读 */
  markAllRead: () => request<void>("/web/notifications/read-all", { method: "PUT" }),
};
