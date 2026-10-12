/**
 * 评论域模块（`/web/tickets/:projectId/:number/comments`）。
 *
 * 类型逐字段对应后端 `TicketCommentViewSchema` / `TicketCommentListResponseSchema` / `TicketCommentResponseSchema`
 * （本包 `src/schemas/ticket-comment.schema.ts`）。三处与「按直觉命名」不同的地方都是后端事实，不是笔误：
 * - 评论 ID 与工单号一样是外部数字 ID，**按字符串承载**，不得退化成 number；
 * - 时间字段是 `providerUpdatedAt`（托管平台最后更新时间，可空）：评论在本地不建索引行，拿不到
 *   「我们第一次看到它」的时间，界面表达新鲜度只能用上游时间；
 * - `issueNumber` 由服务端回带（它正是「评论确属该工单」的核验结果）；界面**不据它拼 URL**，
 *   链接里的工单号始终来自路由参数——两处一旦分叉，点击会把用户带去另一个工单。
 *
 * 分页口径：游标是**下一页页码**的十进制字符串（与工单列表「末条工单号」的游标不同源），列表按时间
 * **倒序**返回（首屏最新），`nextCursor` 指向更早的一页；渲染前要整体反转成时间正序。
 *
 * 域模块不做 `unwrap`（成功/失败分支留给调用方的 `useRequest`），也不生成幂等键——键由**用户动作层**
 * 持有并跨重试复用（见 `web/lib/ticket-write-outcome.ts`）。
 */

import type { ApiResponse } from "@fenix/web-runtime/api/request";
import { request } from "@fenix/web-runtime/api/request";
import type { TicketActor, TicketWriteAccepted } from "./tickets";

/** 评论视图：`body` 是**已剥离身份头**的正文；`version` 是评论内容指纹，编辑时作 `expectedVersion`。 */
export interface TicketComment {
  commentId: string;
  issueNumber: string;
  body: string;
  author: TicketActor;
  version: string;
  providerUpdatedAt: string | null;
}

/** 倒序分页的一页：`items` 内部最新在前，`nextCursor` 为 `null` 表示没有更早的评论。 */
export interface TicketCommentPage {
  items: TicketComment[];
  nextCursor: string | null;
}

/** 列表查询：`limit` 服务端默认 30、上限 100；调用方显式传值，避免默认值在两侧各自漂移。 */
export interface TicketCommentListQuery {
  /** 上一页返回的游标（下一页页码）；首页不传。 */
  cursor?: string;
  limit?: number;
}

/** 创建请求体。后端是 `strictObject`：多传字段（如伪造 author）当场 400。 */
export interface TicketCommentCreateBody {
  body: string;
}

/** 修改请求体：`expectedVersion` 取该评论的 {@link TicketComment.version}。 */
export interface TicketCommentUpdateBody {
  body: string;
  expectedVersion: string;
}

/** 写成功（201/200）：评论本体 + 操作账本 ID（202 只有后者，用 `isUncertainAccepted` 判别）。 */
export interface TicketCommentOutcome {
  comment: TicketComment;
  operationId: string;
}

/** 评论写响应：成功带评论本体，202 带受理体（判别复用 T02 的类型守卫，不引入第二套解析）。 */
export type TicketCommentWriteResult = TicketCommentOutcome | TicketWriteAccepted;

export const ticketCommentsApi = {
  /**
   * 取一页评论（首屏即最新 30 条）。列表**回源托管平台**：上游不可用时服务端报 503，
   * 不会退化成空列表，因此调用方必须保留失败态与重试入口。
   */
  list: (projectId: string, number: string, query?: TicketCommentListQuery): Promise<ApiResponse<TicketCommentPage>> =>
    request<TicketCommentPage>("/web/tickets/:projectId/:number/comments", {
      params: { projectId, number },
      query,
    }),

  /**
   * 发表评论。`idempotencyKey` 由用户动作层生成并跨重试复用（同键同内容返回原操作，同键不同内容 409），
   * 域模块不自己生成——否则每次调用都是新键，服务端的去重账本永远命中不了同一个操作。
   */
  create: (
    projectId: string,
    number: string,
    body: TicketCommentCreateBody,
    idempotencyKey: string,
  ): Promise<ApiResponse<TicketCommentWriteResult>> =>
    request<TicketCommentWriteResult>("/web/tickets/:projectId/:number/comments", {
      method: "POST",
      params: { projectId, number },
      body,
      headers: { "Idempotency-Key": idempotencyKey },
    }),

  /**
   * 修改评论。仅原作者与组织管理员可改（判定只在服务端，前端不预判）；`commentId` 必须属于该工单，
   * 否则服务端按 404 同形拒绝，不给跨工单探测面。
   */
  update: (
    projectId: string,
    number: string,
    commentId: string,
    body: TicketCommentUpdateBody,
    idempotencyKey: string,
  ): Promise<ApiResponse<TicketCommentWriteResult>> =>
    request<TicketCommentWriteResult>("/web/tickets/:projectId/:number/comments/:commentId", {
      method: "PATCH",
      params: { projectId, number, commentId },
      body,
      headers: { "Idempotency-Key": idempotencyKey },
    }),
};
