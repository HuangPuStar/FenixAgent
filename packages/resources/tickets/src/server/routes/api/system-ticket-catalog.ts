/**
 * `/api/system/tickets/:projectId/{labels,members}` 协议层（**平台管理面**）：标签目录与可指派成员。
 *
 * 两条都是**只读目录**，对应 `/web` 面的 `GET /web/ticket-projects/:projectId/{labels,members}`；管理面把
 * 它们收到 `/api/system/tickets/:projectId/...` 之下（冻结契约见 `docs/arch/29-tickets.md` §12 的路径差异
 * 说明）。schema 与视图类型逐字复用：`TicketLabelListResponseSchema` / `TicketMemberListResponseSchema`。
 *
 * 为什么不镜像标签目录的**写**路由（`POST` / `PATCH /web/ticket-projects/:projectId/labels`）：那是仓库级
 * 目录的组织内管理动作，不在「工单页面等价能力」范围内（工单页面的标签编辑器只从目录里勾选）。若管理台需要
 * 「在这里新建标签」，先扩契约再实现。
 *
 * 成员列表的收窄投影与被 `/web` 面共用同一份白名单映射（`toTicketMemberView`）：只回 `userId` 与 `name`，
 * email、手机号与账号状态不进这条路由——跨组织视图不该成为一处新的 PII 出口。
 */

import { ApiSystemErrorResponseSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type * as z from "zod/v4";
import { TicketProjectParamsSchema } from "../../../schemas/ticket.schema";
import { TicketLabelListResponseSchema } from "../../../schemas/ticket-label.schema";
import { TicketMemberListResponseSchema, TicketMemberQuerySchema } from "../../../schemas/ticket-member.schema";
import { getTicketsServerModule } from "../../runtime";
import { systemTicketHandler } from "./system-error";

export function registerSystemTicketCatalogRoutes(app: AnyElysia): void {
  // ── GET /api/system/tickets/:projectId/labels ──
  app.get(
    "/:projectId/labels",
    systemTicketHandler<z.infer<typeof TicketProjectParamsSchema>>(async (route) => ({
      data: { items: await getTicketsServerModule().platform.listLabels(route.params.projectId) },
    })),
    {
      systemApiKeyAuth: true,
      params: TicketProjectParamsSchema,
      response: {
        200: TicketLabelListResponseSchema,
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "列出项目标签（管理面）",
        description:
          "返回该仓库的全部标签（不翻页：标签是仓库级小集合）。项目不存在返回 404，托管平台不可用返回 503（不返回空列表）。标签的增删改不在本面：那是组织内的目录管理动作。",
      },
    },
  );

  // ── GET /api/system/tickets/:projectId/members ──
  app.get(
    "/:projectId/members",
    systemTicketHandler<z.infer<typeof TicketProjectParamsSchema>, z.infer<typeof TicketMemberQuerySchema>>(
      async (route) => ({
        data: await getTicketsServerModule().platform.listMembers(route.params.projectId, route.query),
      }),
    ),
    {
      systemApiKeyAuth: true,
      params: TicketProjectParamsSchema,
      query: TicketMemberQuerySchema,
      response: {
        200: TicketMemberListResponseSchema,
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "列出可指派成员（管理面）",
        description:
          "按**项目所属组织**分页列出可指派成员（工单负责人下拉的数据源），q 对姓名做模糊匹配。只回 { userId, name }：email、手机号与账号状态等敏感字段不在这条路由的投影里。项目不存在返回 404。",
      },
    },
  );
}
