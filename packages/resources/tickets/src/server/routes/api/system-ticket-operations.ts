/**
 * `/api/system/tickets/operations/:operationId` 协议层（**平台管理面**）：幂等操作账本的查询与复核。
 *
 * 这是 `/web/ticket-operations/:operationId` 的镜像：202 之后的复核入口。终态（succeeded / failed /
 * uncertain / needs_review）由账本行自己给出，本层不推断、不重试；返回前对未定状态执行**一次**回源核对
 * （`RECONCILABLE_OPERATION_STATUSES`），核对失败（上游不可用）按 503 上抛。
 *
 * **路径差异（已在 §12 显式标注）**：`/web` 面的账本是 `/web/ticket-operations/**`（不在 `/web/tickets`
 * 之下），而管理面的全部路径都必须落在 `/api/system/tickets` 前缀内——宿主 `app-route` 贡献只能返回**单个**
 * Elysia 实例，实例的前缀是实例级属性，嵌套插件的相对前缀无法逃到另一个根。因此账本挂在 `/operations`
 * 静态段之下：它与 `/:projectId/:number`（动态段）不冲突（静态优先，实测两条路由同时可用），调用方也不会
 * 把账号 ID 与字面量 `operations` 混淆（`projectId` 是 uuid）。
 *
 * 与 `/web` 面唯一的可见性差异：本面按 operationId 直读，不要求「是操作发起人本人」。理由是这两条路径的判据
 * 不同——那一面的调用方是一个用户，本面的调用方持有系统 key；而管理台要复核的账本行可能由组织成员在控制台
 * 发起（详情视图的 `pendingOperationId` 就是这种情况）。
 */

import { ApiSystemErrorResponseSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type * as z from "zod/v4";
import { TicketOperationParamsSchema, TicketOperationResponseSchema } from "../../../schemas/ticket-operation.schema";
import { getTicketsServerModule } from "../../runtime";
import { systemTicketHandler } from "./system-error";

export function registerSystemTicketOperationRoutes(app: AnyElysia): void {
  // ── GET /api/system/tickets/operations/:operationId ──
  app.get(
    "/operations/:operationId",
    systemTicketHandler<z.infer<typeof TicketOperationParamsSchema>>(async (route) => ({
      data: { operation: await getTicketsServerModule().platform.getOperation(route.params.operationId) },
    })),
    {
      systemApiKeyAuth: true,
      params: TicketOperationParamsSchema,
      response: {
        200: TicketOperationResponseSchema,
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "查询工单操作记录（管理面）",
        description:
          "按 operationId 返回一次工单写操作（创建 / 开通项目 / 修改 / 评论 / 标签 / 附件）的账本行：status 为 pending/dispatching/succeeded/failed/uncertain/needs_review，result 为不定型摘要。不存在返回 404；账本行仍在未定状态时返回前会执行一次回源核对（只读上游，绝不重放写入），托管平台不可用返回 503。",
      },
    },
  );
}
