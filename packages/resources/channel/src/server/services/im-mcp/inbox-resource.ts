import type { ImChannelConversationRow } from "../../repositories/im-channel-conversation";
import type { ImChannelEventCursor, ImChannelEventRepository } from "../../repositories/im-channel-event";
import { IM_INBOX_PAGE_SIZE } from "./types";

/**
 * `resources/read im://inbox`（规格 §4.4）。
 *
 * 只返回连接所属 conversation 的 `received` / `delivered` 事件，按 `received_at` 升序分页。读取语义：
 * 取出正文即清空并写 `read_at`，不改变投递状态；重复读取只拿到元数据。分页游标是不透明字符串，
 * 由 `received_at` + 主键组成，保证同一毫秒内的事件也能稳定翻页。
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_SEPARATOR = "|";

export interface ImInboxItem {
  readonly eventId: string;
  readonly senderId: string | null;
  readonly text: string | null;
  readonly receivedAt: string;
}

export interface ImInboxPage {
  readonly events: ImInboxItem[];
  readonly nextCursor: string | null;
}

export function encodeInboxCursor(cursor: ImChannelEventCursor): string {
  return Buffer.from(`${cursor.receivedAt.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`, "utf8").toString("base64url");
}

/** 解析失败返回 null，由调用方转成协议错误；不做「忽略游标、从头开始」的静默降级。 */
export function decodeInboxCursor(value: string): ImChannelEventCursor | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.indexOf(CURSOR_SEPARATOR);
    if (separator <= 0) return null;
    const receivedAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(receivedAt.getTime()) || !UUID_PATTERN.test(id)) return null;
    return { receivedAt, id };
  } catch {
    return null;
  }
}

export async function readImInbox(input: {
  events: ImChannelEventRepository;
  conversation: ImChannelConversationRow;
  after?: ImChannelEventCursor;
  now: Date;
}): Promise<ImInboxPage> {
  const rows = await input.events.findPendingPage({
    channelId: input.conversation.channelId,
    chatType: input.conversation.chatType,
    chatId: input.conversation.chatId,
    ...(input.after ? { after: input.after } : {}),
    // 多取一条判断是否还有下一页；仓储不自己决定 nextCursor。
    limit: IM_INBOX_PAGE_SIZE + 1,
  });

  const page = rows.slice(0, IM_INBOX_PAGE_SIZE);
  const events: ImInboxItem[] = [];
  for (const row of page) {
    const text = await input.events.takeText({ eventId: row.id, readAt: input.now });
    events.push({
      eventId: row.id,
      senderId: row.senderId,
      text: text ?? null,
      receivedAt: row.receivedAt.toISOString(),
    });
  }

  const last = page[page.length - 1];
  return {
    events,
    nextCursor:
      rows.length > IM_INBOX_PAGE_SIZE && last ? encodeInboxCursor({ receivedAt: last.receivedAt, id: last.id }) : null,
  };
}
