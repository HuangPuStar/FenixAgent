import { PaginationParamsSchema, WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";

/**
 * 可指派成员投影（`GET /web/ticket-projects/:projectId/members`）的 schema。
 *
 * 这是**收窄投影**：只允许出现 `userId` 与 `name`。身份目录的其它读取路径（`searchUsers` /
 * `listOrganizationsWithMembers`）会带出 email、手机号与账号状态，工单表单只需要“选一个人”，把 PII
 * 带进这条路由既没有用途，也把工单模块变成一处新的敏感信息出口（裁定二.6 严禁）。
 *
 * `page` / `pageSize` 复用平台通用分页参数（1 起、上限 100）；`q` 对姓名做模糊匹配，不匹配用户 ID。
 */
export const TicketMemberQuerySchema = PaginationParamsSchema.extend({
  q: z.string().min(1).max(64).optional(),
});

export const TicketMemberViewSchema = z.object({ userId: z.string(), name: z.string() });

export const TicketMemberListResponseSchema = WebOkSchema(
  z.object({ items: TicketMemberViewSchema.array(), total: z.number() }),
);
