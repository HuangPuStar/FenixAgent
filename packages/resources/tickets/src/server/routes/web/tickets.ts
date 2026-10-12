/**
 * `/web/tickets/:projectId*` 协议层：工单列表、创建与详情（backend contract §9.1 路由 4–6）。
 *
 * 只做协议适配：把已校验的路径参数、查询串与请求体交给 `TicketFacade`，把它的判别联合映射成状态码与
 * `/web` 信封。**授权一律不在这里**：能读项目 ⟺ 能读写该项目下的工单由 Facade 用受控查询固定
 * （跨组织与不存在同形 404），项目暂停在创建路径报 503，本文件不解释组织、角色或项目状态。
 *
 * 所有工单资源 URL 显式带 `projectId`（方案 §8）：默认项目只决定创建时的落点，历史链接不随默认切换漂移。
 * `number` 按字符串承载（外部数字 ID 在协议中不退化），列表走本包索引、详情回源托管平台。
 */

import { WebErrSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type * as z from "zod/v4";
import {
  TicketCreateRequestSchema,
  TicketDetailParamsSchema,
  TicketDetailResponseSchema,
  TicketListQuerySchema,
  TicketListResponseSchema,
  TicketProjectParamsSchema,
  TicketResponseSchema,
  TicketUncertainResponseSchema,
  TicketUpdateRequestSchema,
} from "../../../schemas/ticket.schema";
import { TicketLabelSetRequestSchema } from "../../../schemas/ticket-label.schema";
import { getTicketsServerModule } from "../../runtime";
import { requireTicketIdempotencyKey, TicketIdempotencyHeadersSchema, ticketHandler } from "./web-error";

export function registerTicketRoutes(app: AnyElysia): void {
  // ── GET /tickets/:projectId ──
  app.get(
    "/tickets/:projectId",
    ticketHandler<z.infer<typeof TicketProjectParamsSchema>, z.infer<typeof TicketListQuerySchema>>(
      async (route, actor) => ({
        data: await getTicketsServerModule().tickets.list(actor, route.params.projectId, route.query),
      }),
    ),
    {
      sessionAuth: true,
      params: TicketProjectParamsSchema,
      query: TicketListQuerySchema,
      response: {
        200: TicketListResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        404: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["Tickets"],
        summary: "列出工单",
        description:
          "按项目列出工单索引（按工单号倒序）；q 只匹配标题，state 缺省为 all，支持 assigneeId / labelId 筛选。分页用游标：nextCursor 为 null 表示没有下一页，limit 默认 30、上限 100。项目不存在或跨组织返回 404，托管平台不可用返回 503（不返回空列表）。",
      },
    },
  );

  // ── POST /tickets/:projectId ──
  app.post(
    "/tickets/:projectId",
    ticketHandler<z.infer<typeof TicketProjectParamsSchema>, unknown, z.infer<typeof TicketCreateRequestSchema>>(
      async (route, actor) => {
        const idempotencyKey = requireTicketIdempotencyKey(route.headers);
        const outcome = await getTicketsServerModule().tickets.create(
          actor,
          route.params.projectId,
          route.body,
          idempotencyKey,
        );
        if (outcome.kind === "uncertain") {
          return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" } };
        }
        return { status: 201, data: { ticket: outcome.ticket, operationId: outcome.operationId } };
      },
    ),
    {
      sessionAuth: true,
      params: TicketProjectParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketCreateRequestSchema,
      response: {
        201: TicketResponseSchema,
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
        summary: "创建工单",
        description:
          "在当前组织可见的项目下创建工单，作者取当前凭据主体（请求体不含作者字段）。请求必须带 Idempotency-Key（8–128 位字母、数字、下划线或短横线），缺失返回 400 IDEMPOTENCY_KEY_REQUIRED、格式非法返回 400 IDEMPOTENCY_KEY_INVALID、同键不同内容返回 409。项目暂停返回 503，上游写入结果未定返回 202，调用方据 operationId 复核而不重发。",
      },
    },
  );

  // ── GET /tickets/:projectId/:number ──
  app.get(
    "/tickets/:projectId/:number",
    ticketHandler<z.infer<typeof TicketDetailParamsSchema>>(async (route, actor) => ({
      data: {
        ticket: await getTicketsServerModule().tickets.get(actor, route.params.projectId, route.params.number),
      },
    })),
    {
      sessionAuth: true,
      params: TicketDetailParamsSchema,
      response: {
        200: TicketDetailResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        404: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["Tickets"],
        summary: "获取工单详情",
        description:
          "按工单号返回详情：正文回源托管平台并剥离身份头，作者归属经本包归属账本核验（未通过核验为 external）。项目或工单不存在返回 404，托管平台不可用返回 503（不返回空正文）。pendingOperationId 非空表示该工单有在途修改，调用方应引导用户先复核。",
      },
    },
  );

  // ── PATCH /tickets/:projectId/:number ──
  app.patch(
    "/tickets/:projectId/:number",
    ticketHandler<z.infer<typeof TicketDetailParamsSchema>, unknown, z.infer<typeof TicketUpdateRequestSchema>>(
      async (route, actor) => {
        const idempotencyKey = requireTicketIdempotencyKey(route.headers);
        const outcome = await getTicketsServerModule().tickets.update(
          actor,
          route.params.projectId,
          route.params.number,
          route.body,
          idempotencyKey,
        );
        if (outcome.kind === "uncertain") {
          return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" as const } };
        }
        return { status: 200, data: { ticket: outcome.ticket, operationId: outcome.operationId } };
      },
    ),
    {
      sessionAuth: true,
      params: TicketDetailParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketUpdateRequestSchema,
      response: {
        200: TicketResponseSchema,
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
        summary: "修改工单",
        description:
          "修改标题/描述/负责人/状态（字段缺席表示不改，assigneeId: null 表示取消指派，至少提供一项），必须带 expectedVersion 与 Idempotency-Key。内容字段要求创建者或管理员，状态与负责人要求创建者、当前负责人或管理员；负责人必须是组织成员。版本不一致返回 409 VERSION_CONFLICT，同键不同内容返回 409 IDEMPOTENCY_CONFLICT，同目标已有在途修改返回 409 TICKET_OPERATION_PENDING。项目暂停返回 503，上游结果未定返回 202。",
      },
    },
  );

  // ── PUT /tickets/:projectId/:number/labels ──
  app.put(
    "/tickets/:projectId/:number/labels",
    ticketHandler<z.infer<typeof TicketDetailParamsSchema>, unknown, z.infer<typeof TicketLabelSetRequestSchema>>(
      async (route, actor) => {
        const idempotencyKey = requireTicketIdempotencyKey(route.headers);
        const outcome = await getTicketsServerModule().tickets.setLabels(
          actor,
          route.params.projectId,
          route.params.number,
          route.body,
          idempotencyKey,
        );
        if (outcome.kind === "uncertain") {
          return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" as const } };
        }
        return { status: 200, data: { ticket: outcome.ticket, operationId: outcome.operationId } };
      },
    ),
    {
      sessionAuth: true,
      params: TicketDetailParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketLabelSetRequestSchema,
      response: {
        200: TicketResponseSchema,
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
        summary: "设置工单标签",
        description:
          "把工单标签整体设置为 labelIds（全量集合语义，空数组表示清空），必须带 expectedVersion 与 Idempotency-Key。要求创建者或管理员；labelIds 里存在本项目未定义的标签返回 400 LABEL_UNKNOWN。版本不一致返回 409 VERSION_CONFLICT，同目标已有在途修改返回 409 TICKET_OPERATION_PENDING。项目暂停返回 503，上游结果未定返回 202。",
      },
    },
  );
}
