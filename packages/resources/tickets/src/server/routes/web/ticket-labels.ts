/**
 * `/web/ticket-projects/:projectId/labels*` 协议层：项目标签目录、新建与修改（backend contract §1.1 路由 6–8）。
 *
 * 只做协议适配：形状校验 → 交给 `TicketLabelFacade` → 把判别联合映射成状态码与 `/web` 信封。**授权一律
 * 不在这里**：成员可读标签目录（项目 `read`），新建与改名是管理员动作（组织内成员 → 403，跨组织/不存在
 * → 404），判定全在 Facade 经 `AccessControlModule` 完成。
 *
 * 标签的**事实源在托管平台**，本包不为它建表：因此这里没有 `expectedVersion`（裁定二.7，上游没有标签
 * 版本字段），但两条写路由照样要求 `Idempotency-Key`——管理员双击提交不该在仓库里留下两个同名标签。
 * 颜色在 schema 层归一（`#ff00AA` → `ff00aa`），避免大小写与 `#` 变成 400 陷阱。
 *
 * 列表**不翻页**：标签是仓库级小集合，适配器已按 `Link` 头翻完；分页接口在这里只会制造「第二页」的
 * 假问题。
 */

import { WebErrSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type * as z from "zod/v4";
import { TicketProjectParamsSchema, TicketUncertainResponseSchema } from "../../../schemas/ticket.schema";
import {
  TicketLabelCreateRequestSchema,
  TicketLabelListResponseSchema,
  TicketLabelParamsSchema,
  TicketLabelResponseSchema,
  TicketLabelUpdateRequestSchema,
} from "../../../schemas/ticket-label.schema";
import { getTicketsServerModule } from "../../runtime";
import { requireTicketIdempotencyKey, TicketIdempotencyHeadersSchema, ticketHandler } from "./web-error";

export function registerTicketLabelRoutes(app: AnyElysia): void {
  // ── GET /ticket-projects/:projectId/labels ──
  app.get(
    "/ticket-projects/:projectId/labels",
    ticketHandler<z.infer<typeof TicketProjectParamsSchema>>(async (route, actor) => ({
      data: { items: await getTicketsServerModule().labels.list(actor, route.params.projectId) },
    })),
    {
      sessionAuth: true,
      params: TicketProjectParamsSchema,
      response: {
        200: TicketLabelListResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        404: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["Tickets"],
        summary: "列出项目标签",
        description:
          "返回该仓库的全部标签（不翻页：标签是仓库级小集合）。项目不存在或跨组织返回 404，托管平台不可用返回 503（不返回空列表）。",
      },
    },
  );

  // ── POST /ticket-projects/:projectId/labels ──
  app.post(
    "/ticket-projects/:projectId/labels",
    ticketHandler<z.infer<typeof TicketProjectParamsSchema>, unknown, z.infer<typeof TicketLabelCreateRequestSchema>>(
      async (route, actor) => {
        const idempotencyKey = requireTicketIdempotencyKey(route.headers);
        const outcome = await getTicketsServerModule().labels.create(
          actor,
          route.params.projectId,
          route.body,
          idempotencyKey,
        );
        if (outcome.kind === "uncertain") {
          return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" } };
        }
        return { status: 201, data: { label: outcome.label, operationId: outcome.operationId } };
      },
    ),
    {
      sessionAuth: true,
      params: TicketProjectParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketLabelCreateRequestSchema,
      response: {
        201: TicketLabelResponseSchema,
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
        summary: "新建项目标签",
        description:
          "在仓库里新建标签，仅组织管理员可调用（其余主体 403）。颜色为 6 位十六进制、可带 #（服务端统一归一为小写不带 #）；name 必填，上限 50 字符，description 上限 200 字符。请求必须带 Idempotency-Key，缺失/非法分别返回 400 IDEMPOTENCY_KEY_REQUIRED / IDEMPOTENCY_KEY_INVALID，同名占用返回 409。上游写入结果未定返回 202。",
      },
    },
  );

  // ── PATCH /ticket-projects/:projectId/labels/:labelId ──
  app.patch(
    "/ticket-projects/:projectId/labels/:labelId",
    ticketHandler<z.infer<typeof TicketLabelParamsSchema>, unknown, z.infer<typeof TicketLabelUpdateRequestSchema>>(
      async (route, actor) => {
        const idempotencyKey = requireTicketIdempotencyKey(route.headers);
        const outcome = await getTicketsServerModule().labels.update(
          actor,
          route.params.projectId,
          route.params.labelId,
          route.body,
          idempotencyKey,
        );
        if (outcome.kind === "uncertain") {
          return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" } };
        }
        return { status: 200, data: { label: outcome.label, operationId: outcome.operationId } };
      },
    ),
    {
      sessionAuth: true,
      params: TicketLabelParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketLabelUpdateRequestSchema,
      response: {
        200: TicketLabelResponseSchema,
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
        summary: "修改项目标签",
        description:
          "改名 / 改色 / 改描述，至少提供一项；仅组织管理员可调用（其余主体 403）。标签不存在或不属于该项目返回 404，同名占用返回 409。请求必须带 Idempotency-Key；上游写入结果未定返回 202。删除标签不开放（方案 §5）。",
      },
    },
  );
}
