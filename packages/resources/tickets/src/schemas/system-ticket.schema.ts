/**
 * 平台管理面（`/api/system/tickets`）的请求查询与响应 schema。
 *
 * 信封与分页口径**沿用 `/api/system/*` 的既有约定**（见 `@fenix/platform-sdk` 的 `ApiSystemPaginationQuerySchema`
 * 与 identity 的 `/api/system/users`）：成功 `{ success: true, data: { items, total, page, pageSize } }`，失败
 * `{ error: { code, message } }`（`ApiSystemErrorResponseSchema`）。`/web` 的游标分页在这里不适用：跨项目的
 * 工单号不构成全局序（排序理由见 `src/server/repositories/ticket-index.ts` 的 `listPlatformPage`）。
 *
 * 行形状**复用 `/web` 列表的 `TicketSummaryViewSchema`** 再补归属坐标：同一份索引投影在两个面上必须逐字段
 * 同义，各自建一份模型迟早会出现「管理面多一个字段、控制台少一个」的漂移。
 */

import { ApiSystemPaginationQuerySchema, WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";
import { TicketSummaryViewSchema } from "./ticket.schema";

/**
 * 列表查询：分页（`page` / `pageSize`）沿用系统面共享 schema，其余四个是筛选条件。
 *
 * `organizationId` / `projectId` 是**筛选**而不是范围强制：这条路径的判据是系统 key（凭据即判据），
 * 调用方本来就允许看全部组织；带上它们只是为了把结果收窄到某组织 / 某项目。`projectId` 按 uuid 校验，
 * 让「拼错 ID 形状」在边界上 400，而不是拿一个永远匹配不到的值去查库。
 */
export const SystemTicketListQuerySchema = ApiSystemPaginationQuerySchema.extend({
  q: z.string().min(1).max(200).optional().describe("标题模糊匹配（不承诺评论全文检索）。"),
  state: z.enum(["open", "closed", "all"]).optional().describe("状态筛选；缺省为 all。"),
  organizationId: z.string().min(1).max(64).optional().describe("按归属组织筛选。"),
  projectId: z.string().uuid().optional().describe("按工单项目筛选。"),
});

/** 管理面列表行：`/web` 列表行 + 归属坐标（字段与 `TicketPlatformSummaryView` 一一对应）。 */
export const SystemTicketSummaryViewSchema = TicketSummaryViewSchema.extend({
  organizationId: z.string().describe("归属组织 ID。"),
  organizationName: z.string().describe("组织展示名；身份目录缺名时回退为组织 ID。"),
  projectId: z.string().describe("工单项目 ID。"),
  projectName: z.string().describe("仓库名。"),
  projectOwner: z.string().describe("仓库 owner（托管平台命名空间）。"),
});

/** 列表响应：`total` 是同一筛选条件下的命中总数（跨页）。 */
export const SystemTicketListResponseSchema = WebOkSchema(
  z.object({
    items: SystemTicketSummaryViewSchema.array(),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  }),
);
