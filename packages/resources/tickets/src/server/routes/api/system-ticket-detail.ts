/**
 * `/api/system/tickets/:projectId/:number` 协议层（**平台管理面**）：详情、修改与标签挂载。
 *
 * 与 `/web/tickets/:projectId/:number` 逐字镜像：同一批 zod schema（`TicketDetailParamsSchema`、
 * `TicketUpdateRequestSchema`、`TicketLabelSetRequestSchema`）、同一批响应 schema（`TicketDetailResponseSchema`、
 * `TicketResponseSchema`、`TicketUncertainResponseSchema`）、同一组状态码语义（409 `VERSION_CONFLICT` /
 * `IDEMPOTENCY_CONFLICT` / `TICKET_OPERATION_PENDING`，202 `uncertain`，503 暂停与上游不可用）。
 *
 * 本文件只做协议适配：路径参数与请求体的形状校验、幂等键的前置校验、把结果映射成 `/api/system/*` 信封。
 * **授权与范围判定一律不在这里**——判据是系统 key（路由守卫），组织与仓库坐标由 Facade 从项目行解析。
 *
 * 缺少 `403` 声明是本面与 `/web` 的**唯一差异**：这一面没有角色判定（凭据即判据），因此不存在「角色不足」
 * 这条失败路径；能力等价的部分照旧（谁能调这一面就能改这些字段，判定不在代码里而在凭据分发）。
 */

import { ApiSystemErrorResponseSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type * as z from "zod/v4";
import {
  TicketDetailParamsSchema,
  TicketDetailResponseSchema,
  TicketResponseSchema,
  TicketUncertainResponseSchema,
  TicketUpdateRequestSchema,
} from "../../../schemas/ticket.schema";
import { TicketLabelSetRequestSchema } from "../../../schemas/ticket-label.schema";
import { getTicketsServerModule } from "../../runtime";
import { requireTicketIdempotencyKey, TicketIdempotencyHeadersSchema } from "../ticket-request-protocol";
import { systemTicketHandler } from "./system-error";

export function registerSystemTicketRoutes(app: AnyElysia): void {
  // ── GET /api/system/tickets/:projectId/:number ──
  app.get(
    "/:projectId/:number",
    systemTicketHandler<z.infer<typeof TicketDetailParamsSchema>>(async (route) => ({
      data: {
        ticket: await getTicketsServerModule().platform.getTicket(route.params.projectId, route.params.number),
      },
    })),
    {
      systemApiKeyAuth: true,
      params: TicketDetailParamsSchema,
      response: {
        200: TicketDetailResponseSchema,
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "获取跨组织工单详情（管理面）",
        description:
          "按项目与工单号返回详情：正文回源托管平台并剥离身份头，作者归属经本包归属账本核验（未通过核验为 external）。与 `/web` 面同形，差别只在判据：本面凭系统 API Key 跨组织读取，没有组织可见性谓词。项目不存在返回 404，托管平台不可用返回 503（不返回空正文）。pendingOperationId 非空表示该工单有在途修改，调用方应引导管理员先复核。",
      },
    },
  );

  // ── PATCH /api/system/tickets/:projectId/:number ──
  app.patch(
    "/:projectId/:number",
    systemTicketHandler<z.infer<typeof TicketDetailParamsSchema>, unknown, z.infer<typeof TicketUpdateRequestSchema>>(
      async (route) => {
        const idempotencyKey = requireTicketIdempotencyKey(route.headers);
        const outcome = await getTicketsServerModule().platform.updateTicket(
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
      systemApiKeyAuth: true,
      params: TicketDetailParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketUpdateRequestSchema,
      response: {
        200: TicketResponseSchema,
        202: TicketUncertainResponseSchema,
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        409: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "修改跨组织工单（管理面）",
        description:
          "修改标题/描述/负责人/状态（字段缺席表示不改，assigneeId: null 表示取消指派，至少提供一项），必须带 expectedVersion 与 Idempotency-Key。负责人仍必须是该组织的有效成员（领域规则不变）；本面不做「创建者或管理员」的角色判定，凭据即判据。版本不一致返回 409 VERSION_CONFLICT，同键不同内容返回 409 IDEMPOTENCY_CONFLICT，同目标已有在途修改返回 409 TICKET_OPERATION_PENDING，项目暂停返回 503，上游结果未定返回 202（调用方据 operationId 复核而不重发）。",
      },
    },
  );

  // ── PUT /api/system/tickets/:projectId/:number/labels ──
  app.put(
    "/:projectId/:number/labels",
    systemTicketHandler<z.infer<typeof TicketDetailParamsSchema>, unknown, z.infer<typeof TicketLabelSetRequestSchema>>(
      async (route) => {
        const idempotencyKey = requireTicketIdempotencyKey(route.headers);
        const outcome = await getTicketsServerModule().platform.setTicketLabels(
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
      systemApiKeyAuth: true,
      params: TicketDetailParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      body: TicketLabelSetRequestSchema,
      response: {
        200: TicketResponseSchema,
        202: TicketUncertainResponseSchema,
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        409: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "设置跨组织工单标签（管理面）",
        description:
          "把工单标签整体设置为 labelIds（全量集合语义，空数组表示清空），必须带 expectedVersion 与 Idempotency-Key。labelIds 里存在本项目未定义的标签返回 400 LABEL_UNKNOWN。版本不一致返回 409 VERSION_CONFLICT，同目标已有在途修改返回 409 TICKET_OPERATION_PENDING，项目暂停返回 503，上游结果未定返回 202。",
      },
    },
  );
}
