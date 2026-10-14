/**
 * `/web/tickets/:projectId/:number/comments*` 协议层：评论列表、发表与修改（backend contract §1.1 路由 1–3）。
 *
 * 只做协议适配：把已校验的路径参数、查询串与请求体交给 `TicketCommentFacade`，把它的判别联合映射成
 * 状态码与 `/web` 信封。**授权一律不在这里**：能不能评论由项目可见性决定（跨组织/不存在同形 404），
 * 能不能编辑某条评论由 Facade 按「回源核验出的原作者或管理员」判定（403），本文件不解释组织或角色。
 *
 * 三处协议口径值得单独记住：
 * 1. 列表**回源托管平台**且按时间倒序返回（首屏最新 30 条，游标是更早一页的页码）；上游不可用报 503，
 *    绝不返回空列表（§8 末句）；
 * 2. 创建与修改都要求 `Idempotency-Key`（缺失/非法 → 400 的两个稳定码），成功码分别是 201 与 200，
 *    上游结果未定统一走 202（调用方据 operationId 复核，不重发）；
 * 3. `commentId` 是外部数字 ID，按字符串承载；非法值在路由 schema 就 400，不进入适配器的 404 判定。
 */

import { WebErrSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type * as z from "zod/v4";
import { TicketDetailParamsSchema, TicketUncertainResponseSchema } from "../../../schemas/ticket.schema";
import {
  TicketCommentCreateRequestSchema,
  TicketCommentListQuerySchema,
  TicketCommentListResponseSchema,
  TicketCommentParamsSchema,
  TicketCommentResponseSchema,
  TicketCommentUpdateRequestSchema,
} from "../../../schemas/ticket-comment.schema";
import { getTicketsServerModule } from "../../runtime";
import { requireTicketIdempotencyKey, TicketIdempotencyHeadersSchema } from "../ticket-request-protocol";
import { ticketHandler } from "./web-error";

export function registerTicketCommentRoutes(app: AnyElysia): void {
  // ── GET /tickets/:projectId/:number/comments ──
  app.get(
    "/tickets/:projectId/:number/comments",
    ticketHandler<z.infer<typeof TicketDetailParamsSchema>, z.infer<typeof TicketCommentListQuerySchema>>(
      async (route, actor) => ({
        data: await getTicketsServerModule().comments.list(
          actor,
          route.params.projectId,
          route.params.number,
          route.query,
        ),
      }),
    ),
    {
      sessionAuth: true,
      params: TicketDetailParamsSchema,
      query: TicketCommentListQuerySchema,
      response: {
        200: TicketCommentListResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        404: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["Tickets"],
        summary: "列出工单评论",
        description:
          "按时间倒序返回评论（首屏即最新一页，页内最新在前）；分页用游标：游标是更早一页的页码（十进制字符串），nextCursor 为 null 表示没有更早的评论，limit 默认 30、上限 100。列表回源托管平台，正文已剥离身份头，作者归属经本包归属账本核验（未通过核验为 external）。项目或工单不存在返回 404，托管平台不可用返回 503（不返回空列表）。",
      },
    },
  );

  // ── POST /tickets/:projectId/:number/comments ──
  app.post(
    "/tickets/:projectId/:number/comments",
    ticketHandler<z.infer<typeof TicketDetailParamsSchema>, unknown, z.infer<typeof TicketCommentCreateRequestSchema>>(
      async (route, actor) => {
        const idempotencyKey = requireTicketIdempotencyKey(route.headers);
        const outcome = await getTicketsServerModule().comments.create(
          actor,
          route.params.projectId,
          route.params.number,
          route.body,
          idempotencyKey,
        );
        if (outcome.kind === "uncertain") {
          return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" } };
        }
        return { status: 201, data: { comment: outcome.comment, operationId: outcome.operationId } };
      },
    ),
    {
      sessionAuth: true,
      params: TicketDetailParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketCommentCreateRequestSchema,
      response: {
        201: TicketCommentResponseSchema,
        202: TicketUncertainResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
        409: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["Tickets"],
        summary: "发表评论",
        description:
          "在工单下发表评论，作者取当前凭据主体（请求体不含作者字段，多传字段一律 400）。请求必须带 Idempotency-Key（8–128 位字母、数字、下划线或短横线），缺失返回 400 IDEMPOTENCY_KEY_REQUIRED、格式非法返回 400 IDEMPOTENCY_KEY_INVALID、同键不同内容返回 409。同键同内容重放返回原操作。上游写入结果未定返回 202，调用方据 operationId 复核而不重发。",
      },
    },
  );

  // ── PATCH /tickets/:projectId/:number/comments/:commentId ──
  app.patch(
    "/tickets/:projectId/:number/comments/:commentId",
    ticketHandler<z.infer<typeof TicketCommentParamsSchema>, unknown, z.infer<typeof TicketCommentUpdateRequestSchema>>(
      async (route, actor) => {
        const idempotencyKey = requireTicketIdempotencyKey(route.headers);
        const outcome = await getTicketsServerModule().comments.update(
          actor,
          route.params.projectId,
          route.params.number,
          route.params.commentId,
          route.body,
          idempotencyKey,
        );
        if (outcome.kind === "uncertain") {
          return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" } };
        }
        return { status: 200, data: { comment: outcome.comment, operationId: outcome.operationId } };
      },
    ),
    {
      sessionAuth: true,
      params: TicketCommentParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketCommentUpdateRequestSchema,
      response: {
        200: TicketCommentResponseSchema,
        202: TicketUncertainResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
        409: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["Tickets"],
        summary: "修改评论",
        description:
          "修改评论正文，仅原作者与组织管理员可改（其余主体 403，判定只在服务端）。请求必须带 Idempotency-Key 与 expectedVersion（评论当前的内容指纹，取列表或写响应里的 version）：指纹不符返回 409 VERSION_CONFLICT 且不产生任何写入；评论不属于该工单或已被删除返回 404；上游写入结果未定返回 202。",
      },
    },
  );
}
