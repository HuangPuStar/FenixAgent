/**
 * 组织工单项目域模块（`/web/ticket-projects...`）：总览、可指派成员、项目标签目录。
 *
 * 类型逐字段对应后端 `TicketProjectOverviewResponseSchema`（本包 `src/schemas/ticket-project.schema.ts`）：
 * 后端不返回的字段一律不在这里出现——前端多长一个「幻影字段」只会渲染出永不存在的值，而类型检查不会报错。
 * 域模块只做请求与载荷塑形：**返回 `ApiResponse` 而不 `unwrap`**（成功/失败分支在 `useRequest` 的
 * `error` / `onError` 里处理），也不做 UI 反馈。
 *
 * 状态是**组织级三态**（不是每项目的 `status`）：
 * - `unconfigured` 未开通：前端走「尚未开通」说明分支，且**不发任何工单请求**；
 * - `ready` 可用；
 * - `paused` 组织级暂停：读仍可用（暂停只拦写路径，写请求被服务端以 503 拒绝），因此不阻断列表。
 */

import type { ApiResponse } from "@fenix/web-runtime/api/request";
import { request } from "@fenix/web-runtime/api/request";

/** 组织级开通状态；取值与后端 `state` 枚举逐字一致。 */
export type TicketProjectState = "unconfigured" | "ready" | "paused";

/** 单个项目的开关（`paused` 时该项目的写路径被服务端拒绝，读路径正常）。 */
export type TicketProjectStatus = "active" | "paused";

/** 开通时的仓库坐标快照（展示与排障用；真实事实源在托管平台）。 */
export interface TicketProjectRepository {
  connectionId: string;
  providerRepositoryId: string;
  owner: string;
  name: string;
}

/**
 * 工单项目视图。`bindingId` 是 git 仓库绑定 ID，`repository` 是开通时的坐标快照。
 *
 * `isDefault` 只标识默认项目；`defaultProjectId` 仍在总览上单独给出——列表页要的是「当前落点」，
 * 而不是让前端在数组里自己找一遍（两处真相会漂移）。
 */
export interface TicketProject {
  id: string;
  organizationId: string;
  bindingId: string;
  repository: TicketProjectRepository;
  isDefault: boolean;
  status: TicketProjectStatus;
  createdAt: string;
  updatedAt: string;
}

/** 总览：当前组织可见的项目、默认项目与组织级状态。 */
export interface TicketProjectsOverview {
  projects: TicketProject[];
  defaultProjectId: string | null;
  state: TicketProjectState;
}

/**
 * 可指派成员：组织成员的**收窄投影**（只有 ID 与姓名）。
 *
 * 字段名是 `userId` 而不是 `id`，分页是 `page`/`pageSize` + `total` 而不是游标——两者都是后端事实
 * （`TicketMemberViewSchema` 与 `PaginationParamsSchema`）。前端**不**读组织成员接口、也不要用
 * `useOrgSession` 自己拼候选：这个端点由服务端负责收窄投影（不带 email / 手机号 / 账号状态）。
 */
export interface TicketProjectMember {
  userId: string;
  name: string;
}

/**
 * 成员页：`total` 是同一 `q` 下命中总数，界面据此判断「还有更多」（后端按 `ORDER BY` 姓名 + 用户 ID
 * 稳定排序，翻页不会漏项或重项）。
 */
export interface TicketProjectMemberPage {
  items: TicketProjectMember[];
  total: number;
}

/** 成员查询：`q` 在服务端过滤（成员超过一页时前端不做全量拉取后本地过滤）。 */
export interface TicketProjectMemberQuery {
  q?: string;
  /** 1 起；服务端默认 1。 */
  page?: number;
  /** 服务端默认 20、上限 100。 */
  pageSize?: number;
}

/** 项目标签目录项：工单视图里的标签投影再加 `description`（目录才需要描述文案）。 */
export interface TicketProjectLabel {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}

export const ticketProjectsApi = {
  /** 列表页用它决定「未开通 / 正常」分支与创建时的默认落点。 */
  overview: () => request<TicketProjectsOverview>("/web/ticket-projects"),

  /** 可指派成员候选；关键词与翻页都由服务端完成。 */
  members: (projectId: string, query?: TicketProjectMemberQuery): Promise<ApiResponse<TicketProjectMemberPage>> =>
    request<TicketProjectMemberPage>("/web/ticket-projects/:projectId/members", { params: { projectId }, query }),

  /** 项目标签目录：仓库级小集合，服务端一次给全（适配器已按 `Link` 头翻完），不翻页。 */
  labels: (projectId: string): Promise<ApiResponse<{ items: TicketProjectLabel[] }>> =>
    request<{ items: TicketProjectLabel[] }>("/web/ticket-projects/:projectId/labels", { params: { projectId } }),
};
