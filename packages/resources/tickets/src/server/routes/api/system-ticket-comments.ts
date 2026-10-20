/**
 * `/api/system/tickets/:projectId/:number/comments*` 协议层（**平台管理面**）：评论列表、发表与修改。
 *
 * 与 `/web/tickets/:projectId/:number/comments*` 逐字镜像：同一批 zod schema、同一批响应 schema、同一组状态码
 * 语义（首屏最新一页的游标分页、201/200 与 202、409 的三种冲突）。本文件只做协议适配，授权与组织范围不在这里
 * ——判据是系统 key，坐标由 Facade 从项目行解析。
 *
 * 一处**行为差异**：发表与修改评论的作者是**平台审计主体**（系统托管租户），不是某个组织成员；且修改不再经
 * 「原作者或管理员」判定（本面没有角色判定）。作者归属的核验口径不变（身份头 + 归属行 + 摘要 + 组织四处吻合）。
 */

import { ApiSystemErrorResponseSchema } from "@fenix/platform-sdk";
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
import { systemTicketHandler } from "./system-error";

export function registerSystemTicketCommentRoutes(app: AnyElysia): void {
  // ── GET /api/system/tickets/:projectId/:number/comments ──
  app.get(
    "/:projectId/:number/comments",
    systemTicketHandler<z.infer<typeof TicketDetailParamsSchema>, z.infer<typeof TicketCommentListQuerySchema>>(
      async (route) => ({
        data: await getTicketsServerModule().platform.listComments(
          route.params.projectId,
          route.params.number,
          route.query,
        ),
      }),
    ),
    {
      systemApiKeyAuth: true,
      params: TicketDetailParamsSchema,
      query: TicketCommentListQuerySchema,
      response: {
        200: TicketCommentListResponseSchema,
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "列出跨组织工单评论（管理面）",
        description:
          "按时间倒序返回评论（首屏即最新一页，页内最新在前）；游标是更早一页的页码（十进制字符串），nextCursor 为 null 表示没有更早的评论，limit 默认 30、上限 100。列表回源托管平台，正文已剥离身份头，作者归属经本包归属账本核验（未通过核验为 external）。项目或工单不存在返回 404，托管平台不可用返回 503（不返回空列表）。",
      },
    },
  );

  // ── POST /api/system/tickets/:projectId/:number/comments ──
  app.post(
    "/:projectId/:number/comments",
    systemTicketHandler<
      z.infer<typeof TicketDetailParamsSchema>,
      unknown,
      z.infer<typeof TicketCommentCreateRequestSchema>
    >(async (route) => {
      const idempotencyKey = requireTicketIdempotencyKey(route.headers);
      const outcome = await getTicketsServerModule().platform.createComment(
        route.params.projectId,
        route.params.number,
        route.body,
        idempotencyKey,
      );
      if (outcome.kind === "uncertain") {
        return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" as const } };
      }
      return { status: 201, data: { comment: outcome.comment, operationId: outcome.operationId } };
    }),
    {
      systemApiKeyAuth: true,
      params: TicketDetailParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketCommentCreateRequestSchema,
      response: {
        201: TicketCommentResponseSchema,
        202: TicketUncertainResponseSchema,
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        409: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "发表工单评论（管理面）",
        description:
          "在工单下发表评论，作者取平台审计主体（系统托管租户；请求体不含作者字段，多传字段一律 400）。请求必须带 Idempotency-Key（8–128 位字母、数字、下划线或短横线），缺失返回 400 IDEMPOTENCY_KEY_REQUIRED、格式非法返回 400 IDEMPOTENCY_KEY_INVALID、同键不同内容返回 409。同键同内容重放返回原操作。上游写入结果未定返回 202，调用方据 operationId 复核而不重发。",
      },
    },
  );

  // ── PATCH /api/system/tickets/:projectId/:number/comments/:commentId ──
  app.patch(
    "/:projectId/:number/comments/:commentId",
    systemTicketHandler<
      z.infer<typeof TicketCommentParamsSchema>,
      unknown,
      z.infer<typeof TicketCommentUpdateRequestSchema>
    >(async (route) => {
      const idempotencyKey = requireTicketIdempotencyKey(route.headers);
      const outcome = await getTicketsServerModule().platform.updateComment(
        route.params.projectId,
        route.params.number,
        route.params.commentId,
        route.body,
        idempotencyKey,
      );
      if (outcome.kind === "uncertain") {
        return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" as const } };
      }
      return { status: 200, data: { comment: outcome.comment, operationId: outcome.operationId } };
    }),
    {
      systemApiKeyAuth: true,
      params: TicketCommentParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketCommentUpdateRequestSchema,
      response: {
        200: TicketCommentResponseSchema,
        202: TicketUncertainResponseSchema,
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        409: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "修改工单评论（管理面）",
        description:
          "修改评论正文，必须带 Idempotency-Key 与 expectedVersion（评论当前的内容指纹，取列表或写响应里的 version）：指纹不符返回 409 VERSION_CONFLICT 且不产生任何写入；评论不属于该工单或已被删除返回 404。本面不做「原作者或管理员」判定（凭据即判据），上游写入结果未定返回 202。",
      },
    },
  );
}
