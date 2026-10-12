/**
 * 组织工单项目域模块（`GET /web/ticket-projects`）。
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

export const ticketProjectsApi = {
  /** 列表页用它决定「未开通 / 正常」分支与创建时的默认落点。 */
  overview: () => request<TicketProjectsOverview>("/web/ticket-projects"),
};
