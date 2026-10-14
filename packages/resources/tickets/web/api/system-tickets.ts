/**
 * 平台管理面（`/api/system/tickets`）的浏览器侧模块：跨组织工单列表。
 *
 * 凭据是系统 master key（`RCS_SYSTEM_API_KEYS`），由 `/admin` 的门后提供，经 `request()` 的 `bearerToken`
 * 注入 `Authorization` 头——与 observer / plugin-market 的管理面同一条通道
 * （`@fenix/web-runtime/lib/admin-key`）。**每次请求现取**：门内 401 会清掉它，缓存一份会让下次请求继续用
 * 失效凭据。
 *
 * 行字段与后端 `SystemTicketSummaryViewSchema`（本包 `src/schemas/system-ticket.schema.ts`）逐字段一致：
 * `/web` 列表行的全部字段（同源同义）+ 归属坐标。坐标是**服务端字段**（列表由后端 join 项目表得到），
 * 不是前端回填。
 *
 * 分页是页码语义（`/api/system/*` 的既有口径），与 `/web/tickets` 的工单号游标不同：跨项目时工单号不构成
 * 全局序，游标在这里没有意义。
 */

import { type ApiResponse, request } from "@fenix/web-runtime/api/request";
import { getAdminKey } from "@fenix/web-runtime/lib/admin-key";
import type { TicketActor, TicketLabel, TicketState, TicketStateFilter, TicketSyncStatus } from "./tickets";

/** 管理面列表行：`/web` 列表行的字段 + 归属组织与仓库坐标。 */
export interface SystemTicketSummary {
  issueNumber: string;
  title: string;
  state: TicketState;
  author: TicketActor;
  assignee: TicketActor | null;
  labels: TicketLabel[];
  version: string;
  providerUpdatedAt: string | null;
  syncedAt: string;
  syncStatus: TicketSyncStatus;
  organizationId: string;
  /** 组织展示名；身份目录缺名时后端回退为组织 ID。 */
  organizationName: string;
  projectId: string;
  projectName: string;
  projectOwner: string;
}

/** 列表查询：`organizationId` / `projectId` 是筛选而不是范围强制（本面的凭据本来就允许看全部组织）。 */
export interface SystemTicketListQuery {
  page: number;
  pageSize: number;
  q?: string;
  state?: TicketStateFilter;
  organizationId?: string;
  projectId?: string;
}

export interface SystemTicketListResult {
  items: SystemTicketSummary[];
  /** 同一筛选条件下的命中总数（跨页）。 */
  total: number;
  page: number;
  pageSize: number;
}

/** 域模块不做 `unwrap`：成功/失败分支留给调用方的 `useRequest`（与 `./tickets` 同口径）。 */
export const systemTicketsApi = {
  list: (query: SystemTicketListQuery): Promise<ApiResponse<SystemTicketListResult>> =>
    request<SystemTicketListResult>("/api/system/tickets", {
      bearerToken: getAdminKey() ?? undefined,
      method: "GET",
      query,
    }),
};
