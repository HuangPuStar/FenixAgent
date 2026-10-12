/**
 * `/web/ticket-projects*` 协议层：组织工单项目的查询、开通与默认项目切换（backend contract §9.1 路由 1–3）。
 *
 * 只做协议适配：请求体/路径参数的形状校验、把请求交给 Facade、把 Facade 的结果映射成状态码与 `/web` 信封。
 * **授权判定一律不在这里**——「谁能开通、谁能切换」由 `TicketProjectFacade` 经 `AccessControlModule` 判定
 * （组织内成员 → 403、跨组织 → 404），本文件不解释角色、组织或项目状态。
 *
 * 列表对成员开放（读项目是成员的默认动作），开通与切换是管理动作。开通走 202 分支时表示上游结果未定
 * （§8.3），前端据此提示「提交结果确认中」并按 `operationId` 复核，本层不重试、不轮询。
 */

import { WebErrSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type * as z from "zod/v4";
import { TicketUncertainResponseSchema } from "../../../schemas/ticket.schema";
import {
  TicketProjectOverviewResponseSchema,
  TicketProjectPatchRequestSchema,
  TicketProvisionRequestSchema,
  TicketProvisionResponseSchema,
} from "../../../schemas/ticket-project.schema";
import { getTicketsServerModule } from "../../runtime";
import { requireTicketIdempotencyKey, TicketIdempotencyHeadersSchema, ticketHandler } from "./web-error";

export function registerTicketProjectRoutes(app: AnyElysia): void {
  // ── GET /ticket-projects ──
  app.get(
    "/ticket-projects",
    ticketHandler(async (_route, actor) => ({
      data: await getTicketsServerModule().projects.list(actor),
    })),
    {
      sessionAuth: true,
      response: {
        200: TicketProjectOverviewResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
      },
      detail: {
        tags: ["Tickets"],
        summary: "列出工单项目",
        description:
          "返回当前组织可见的工单项目、默认项目 ID 与组织级开通状态（unconfigured 未开通 / ready 可用 / paused 已暂停）。跨组织项目不出现在结果中。",
      },
    },
  );

  // ── POST /ticket-projects/default ──
  app.post(
    "/ticket-projects/default",
    ticketHandler<unknown, unknown, z.infer<typeof TicketProvisionRequestSchema>>(async (route, actor) => {
      const idempotencyKey = requireTicketIdempotencyKey(route.headers);
      const outcome = await getTicketsServerModule().projects.provisionDefault(actor, route.body, idempotencyKey);
      if (outcome.kind === "uncertain") {
        return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" } };
      }
      return { data: { project: outcome.project, operation: outcome.operation } };
    }),
    {
      sessionAuth: true,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketProvisionRequestSchema,
      response: {
        200: TicketProvisionResponseSchema,
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
        summary: "开通工单项目",
        description:
          "为当前组织开通工单项目：mode=create 在当前凭据账号下新建私有仓库，mode=bind 绑定既有仓库。请求必须带 Idempotency-Key（8–128 位字母、数字、下划线或短横线），缺失返回 400 IDEMPOTENCY_KEY_REQUIRED、格式非法返回 400 IDEMPOTENCY_KEY_INVALID。上游写入结果未定时返回 202，调用方据 operationId 复核，不要重发。",
      },
    },
  );

  // ── PATCH /ticket-projects/default ──
  app.patch(
    "/ticket-projects/default",
    ticketHandler<unknown, unknown, z.infer<typeof TicketProjectPatchRequestSchema>>(async (route, actor) => {
      const { defaultProjectId, status } = route.body;
      return {
        data: await getTicketsServerModule().projects.setDefault(actor, {
          ...(defaultProjectId === undefined ? {} : { projectId: defaultProjectId }),
          ...(status === undefined ? {} : { status }),
        }),
      };
    }),
    {
      sessionAuth: true,
      body: TicketProjectPatchRequestSchema,
      response: {
        200: TicketProjectOverviewResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
        409: WebErrSchema,
      },
      detail: {
        tags: ["Tickets"],
        summary: "切换默认项目或启停组织工单",
        description:
          "defaultProjectId 切换默认项目（目标必须处于可用状态，暂停中的项目设为默认返回 409）；status 启停组织工单（作用在默认项目上）。两者至少提供一项，返回更新后的项目总览。",
      },
    },
  );
}
