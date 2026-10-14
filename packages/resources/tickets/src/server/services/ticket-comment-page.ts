/**
 * 评论的**倒序分页**机制（方案 §12：10,000 条评论的讨论串，首屏只请求 30 条）。
 *
 * 为什么需要专门实现：适配器（`@fenix/git`）按创建时间**升序**返回评论，`cursor` 是页码，`nextCursor`
 * 指向更后的页；而评论区要「首屏 = 最新一页、向下加载更早」。若直接沿用升序口径，首屏拿到的是最古老的
 * 30 条，用户要翻 333 次才看到今天的讨论——这正是方案禁止的形态。
 *
 * 机制（两次请求，只读两页，绝不整串扫描）：
 * 1. 首屏先用一次第 1 页请求探出适配器从 `Link` 头透出的**末页页码**（`GitPage.lastCursor`，T01 为此专门
 *    落地），再直接取末页：这一页就是「最新 30 条」。
 * 2. `nextCursor` 是**更早一页的页码**（末页 - 1），逐页递减到第 1 页为止；请求方原样回传即可。
 * 3. `lastCursor` 缺失（上游没有分页信息：单页仓库不发 `Link` 头）时第 1 页就是全部内容，按倒序返回并
 *    结束。这是**显式登记**的退化点：上游若在多页场景下发不出 `Link` 头，首屏只会看到最旧的一页——属上游
 *    能力缺失，不静默冒充最新（backend contract §11.1 的退化口径）。
 *
 * 页内顺序同样反转：接口对外的口径是「最新在前」，前端据此把整串评论渲染成时间正序。
 */

import type { GitComment, GitScopedClient } from "@fenix/git/server";

export interface TicketCommentPageSlice {
  readonly items: readonly GitComment[];
  /** 更早一页的页码；`null` 表示已经到底（没有更早的评论）。 */
  readonly nextCursor: string | null;
}

/** 取一页评论，按时间倒序返回（页内最新在前）；`cursor` 是更早一页的页码。 */
export async function listDescendingPage(
  client: GitScopedClient,
  issueNumber: string,
  limit: number,
  cursor: string | undefined,
): Promise<TicketCommentPageSlice> {
  if (cursor === undefined) {
    const first = await client.comments.list(issueNumber, { limit });
    const last = lastPageNumber(first.lastCursor);
    if (last === null || last <= 1) return { items: reversed(first.items), nextCursor: null };
    const newest = await client.comments.list(issueNumber, { cursor: String(last), limit });
    return { items: reversed(newest.items), nextCursor: String(last - 1) };
  }

  const pageNumber = Number.parseInt(cursor, 10);
  const page = await client.comments.list(issueNumber, { cursor, limit });
  // 评论被删除后页码会变少：越界请求拿到空页时回退到当前末页，避免用户逐页点过一串空页。
  const last = lastPageNumber(page.lastCursor);
  if (page.items.length === 0 && last !== null && last < pageNumber) {
    const fallback = await client.comments.list(issueNumber, { cursor: String(last), limit });
    return { items: reversed(fallback.items), nextCursor: last > 1 ? String(last - 1) : null };
  }
  return { items: reversed(page.items), nextCursor: pageNumber > 1 ? String(pageNumber - 1) : null };
}

/** 页内反转：适配器升序，接口对外是「最新在前」。 */
function reversed(items: readonly GitComment[]): readonly GitComment[] {
  return [...items].reverse();
}

/** `Link` 头的末页页码；缺失或非法一律按 `null`（调用方按单页处理，不猜一个页码）。 */
function lastPageNumber(lastCursor: string | null | undefined): number | null {
  if (lastCursor === null || lastCursor === undefined) return null;
  const page = Number.parseInt(lastCursor, 10);
  return Number.isFinite(page) && page >= 1 ? page : null;
}
