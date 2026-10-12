/**
 * `/web/ticket-operations/:operationId` 协议层：幂等操作账本的查询（backend contract §9.1 路由 7）。
 *
 * 只做协议适配：把路径参数交给 `TicketFacade.getOperation`，由它按「仅操作的 actor 本人可查」判定
 * （决策 D5）——不是本人与不存在**同形**返回 404，不区分原因，管理员也不额外放行，因此本文件看不到
 * 任何可见性分支。
 *
 * 这是 `POST` 写路径返回 202 之后的复核入口：前端在「提交结果确认中」时按 `operationId` 手动刷新，
 * 终态（succeeded / failed / uncertain）由账本行自己给出，本层不推断、不重试。
 *
 * T03 起本路由在返回前会触发一次恢复核对（backend contract §8.1）：核对要回源读取，托管平台不可用时
 * 会抛 503，因此这里必须声明该状态码，否则响应体不做校验、OpenAPI 也查不到这条失败路径。
 */

import { WebErrSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type * as z from "zod/v4";
import { TicketOperationParamsSchema, TicketOperationResponseSchema } from "../../../schemas/ticket-operation.schema";
import { getTicketsServerModule } from "../../runtime";
import { ticketHandler } from "./web-error";

export function registerTicketOperationRoutes(app: AnyElysia): void {
  // ── GET /ticket-operations/:operationId ──
  app.get(
    "/ticket-operations/:operationId",
    ticketHandler<z.infer<typeof TicketOperationParamsSchema>>(async (route, actor) => ({
      data: { operation: await getTicketsServerModule().tickets.getOperation(actor, route.params.operationId) },
    })),
    {
      sessionAuth: true,
      params: TicketOperationParamsSchema,
      response: {
        200: TicketOperationResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        404: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["Tickets"],
        summary: "查询工单操作记录",
        description:
          "按 operationId 返回一次工单写操作（创建 / 开通项目 / 修改 / 评论 / 标签）的账本行：status 为 pending/dispatching/succeeded/failed/uncertain/needs_review，result 为不定型摘要。仅操作发起人本人可查，其余一律 404；账本行仍在未定状态时返回前会执行一次回源核对，托管平台不可用返回 503。",
      },
    },
  );
}
