import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { notification } from "../db/schema";

// ── Types ──

// service 层统一结果类型（本地定义，参照 task.ts 的先例；`./types` 模块并不存在，原 import 为遗留编译错误）
type ServiceSuccess<T> = { success: true; data: T };
type ServiceFailure = { success: false; error: { code: string; message: string } };
type ServiceResult<T> = ServiceSuccess<T> | ServiceFailure;

export interface CreateNotificationInput {
  type: "platform" | "agent" | "knowledge";
  subType?: string;
  title: string;
  content?: string;
  targetUrl?: string;
  metadata?: Record<string, unknown>;
  userId?: string | null; // null = 所有用户（平台级）
  organizationId: string;
}

export interface NotificationInfo {
  id: string;
  type: string;
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
  items: NotificationInfo[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Helpers ──

function mapRow(row: typeof notification.$inferSelect): NotificationInfo {
  return {
    id: row.id,
    type: row.type,
    subType: row.subType,
    title: row.title,
    content: row.content,
    targetUrl: row.targetUrl,
    metadata: row.metadata as Record<string, unknown> | null,
    userId: row.userId,
    organizationId: row.organizationId,
    isRead: row.isRead,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── CRUD ──

/** 创建通知 */
export async function createNotification(input: CreateNotificationInput): Promise<ServiceSuccess<NotificationInfo>> {
  const [row] = await db.insert(notification).values(input).returning();
  return { success: true, data: mapRow(row!) };
}

/** 分页查询通知列表 */
export async function listNotifications(
  userId: string,
  organizationId: string,
  opts: { page: number; pageSize: number; filter: "all" | "read" | "unread" },
): Promise<ServiceSuccess<NotificationListResult>> {
  const { page, pageSize, filter } = opts;
  const offset = (page - 1) * pageSize;

  // 可见范围：平台级（userId IS NULL）或当前用户
  const visibility = or(isNull(notification.userId), eq(notification.userId, userId));

  // 已读/未读筛选
  const readCondition =
    filter === "read"
      ? eq(notification.isRead, true)
      : filter === "unread"
        ? eq(notification.isRead, false)
        : undefined;

  const where = readCondition
    ? and(eq(notification.organizationId, organizationId), visibility, readCondition)
    : and(eq(notification.organizationId, organizationId), visibility);

  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(notification).where(where);

  const rows = await db
    .select()
    .from(notification)
    .where(where)
    .orderBy(desc(notification.createdAt))
    .limit(pageSize)
    .offset(offset);

  return {
    success: true,
    data: {
      items: rows.map(mapRow),
      total: Number(total),
      page,
      pageSize,
    },
  };
}

/** 获取未读数量 */
export async function getUnreadCount(
  userId: string,
  organizationId: string,
): Promise<ServiceSuccess<{ count: number }>> {
  const visibility = or(isNull(notification.userId), eq(notification.userId, userId));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(notification)
    .where(and(eq(notification.organizationId, organizationId), visibility, eq(notification.isRead, false)));

  return { success: true, data: { count: Number(total) } };
}

/** 标记单条已读 */
export async function markAsRead(notificationId: string, userId: string): Promise<ServiceResult<void>> {
  const [row] = await db.select().from(notification).where(eq(notification.id, notificationId)).limit(1);

  if (!row) return { success: false, error: { code: "NOT_FOUND", message: "通知不存在" } };

  // 只能标记自己的通知或平台通知
  if (row.userId && row.userId !== userId) {
    return { success: false, error: { code: "FORBIDDEN", message: "无权操作此通知" } };
  }

  await db.update(notification).set({ isRead: true }).where(eq(notification.id, notificationId));
  return { success: true, data: undefined };
}

/** 全部标记已读 */
export async function markAllAsRead(userId: string, organizationId: string): Promise<ServiceResult<void>> {
  await db
    .update(notification)
    .set({ isRead: true })
    .where(
      and(
        eq(notification.organizationId, organizationId),
        or(isNull(notification.userId), eq(notification.userId, userId)),
        eq(notification.isRead, false),
      ),
    );

  return { success: true, data: undefined };
}
