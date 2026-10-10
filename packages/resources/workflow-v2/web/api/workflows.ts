// web/api/workflows.ts
// 列表页的域模块：本地注册表的工作流增删改查（冻结 §4.3 的 `/web/workflow-v2/workflows` 四条端点）。
//
// 信封与错误口径与 `canvas-session.ts` 同源：`request()` 已解掉 `{ success, data }` 一层，失败**返回**
// `{ success: false, error: { code, message } }` 而不 throw（§5.2），调用方必须 `unwrap()` 或显式判
// `success`。错误码是本层的输出（`ORG_APP_NOT_BOUND` / `WORKFLOW_NOT_FOUND` …），**文案属视图**：本层
// 不带任何用户可见字符串，也不把错误降级成空数据。
//
// 字段形状以服务端为准（`src/server/routes/web/workflows.ts` 的 `WorkflowItemSchema` 等 zod schema），
// 不声明后端没有的键：列表项没有 `desc` / `iconUri`，状态是 `syncState` 而不是设计草稿里的 `status`。
//
// 身份（user / org）不在本层拼装：组织谓词由服务端从会话 cookie 推导，`space_id` / `project_id` 也由
// 服务端注入（冻结 §4.3/§6），客户端传同名值一律被忽略——因此本层不提供这两个入参。

import { type ApiResponse, request } from "@fenix/web-runtime/api/request";

/** 域路径前缀；与 `canvas-session.ts` 各自写全路径，不做跨文件的常量共享（两处消费点，改一处会静默漂移）。 */
const WORKFLOWS_PATH = "/web/workflow-v2/workflows";

/** 可取消调用的选项；页面在重试 / 卸载时 abort 在途请求（§3.4「主动取消用 signal」）。 */
export interface WorkflowRequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * `GET /web/workflow-v2/workflows` 的列表项（服务端 `WorkflowItemSchema` 逐字段对应）。
 *
 * `syncState` 是本地注册表的同步状态：列表只回 `active` 的记录（已软删的不可见），`pending_delete` 因此
 * 只在「删除进行中」这类竞态下短暂出现，UI 仍要能表达它而不是当成未知值。
 *
 * `publishState` / `publishedVersion` 是**上游**口径（平台不维护本地版本镜像）：`unknown` 表示本次没读到，
 * UI 必须与「未发布」分开呈现（把它渲染成「未发布」正是本次报障的错误方向）。
 */
export interface WorkflowV2WorkflowItem {
  /** 本地注册表主键（`PATCH` / `DELETE` 的路径参数）。 */
  readonly id: string;
  /** 上游 workflow ID：画布深链与票据绑定用的都是它，**不是** `id`。 */
  readonly upstreamWorkflowId: string;
  /** 归属的租户上游应用 ID。 */
  readonly appId: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly visibility: string;
  /** 上游发布态；`unknown` 只表示没读到，不代表未发布。 */
  readonly publishState: "published" | "unpublished" | "unknown";
  /** 上游当前发布版本（形如 `v0.0.1`，**已带 `v` 前缀**）；仅 `published` 时非 null。 */
  readonly publishedVersion: string | null;
  readonly syncState: "active" | "pending_delete";
  /** ISO 8601 时间串（服务端 `Date#toISOString()`）。 */
  readonly updatedAt: string;
}

/** 列表分页体；`total` 是**过滤后**的总数（用于渲染页码），不是本页条数。 */
export interface WorkflowV2WorkflowPage {
  readonly items: readonly WorkflowV2WorkflowItem[];
  readonly total: number;
}

/** 列表查询：`name` 为空串会被服务端判成非法（`min(1)`），调用方应省略而不是传空串。 */
export interface WorkflowV2WorkflowListQuery {
  readonly page: number;
  readonly size: number;
  readonly name?: string;
}

/** 创建入参（`POST /workflows`）；`desc` / `iconUri` 省略时由服务端取默认值。 */
export interface WorkflowV2CreateInput {
  readonly name: string;
  readonly desc?: string;
  readonly iconUri?: string;
}

/** 更新入参（`PATCH /workflows/:id`）；服务端要求至少给一项，否则回 400 `INVALID_REQUEST`。 */
export interface WorkflowV2UpdateInput {
  readonly name?: string;
  readonly desc?: string;
  readonly iconUri?: string;
}

/** 创建结果：本地 id 用于后续 CRUD，上游 id 用于打开画布。 */
export interface WorkflowV2CreatedWorkflow {
  readonly id: string;
  readonly upstreamWorkflowId: string;
}

/**
 * 删除结果。
 *
 * `deleted=false` 是**业务拒绝**而不是失败：上游删除策略非 0（1=首发审核中，2=需先下架）时服务端不落软删，
 * 记录仍在列表里，`strategy` 给出拒绝原因；调用方必须据此给出提示，不得当成删除成功（冻结 §4.3）。
 */
export interface WorkflowV2DeleteResult {
  /** 是否已从控制台列表移除（本地软删完成）。 */
  readonly deleted: boolean;
  /** 上游删除策略：0=可删；非 0 且 `deleted=false` 时表示拒绝原因；探不到时为 null。 */
  readonly strategy: number | null;
}

/** 列出当前组织的工作流（服务端按 `activeOrganizationId` 隔离，已软删的不可见）。 */
export function fetchWorkflows(
  query: WorkflowV2WorkflowListQuery,
  options: WorkflowRequestOptions = {},
): Promise<ApiResponse<WorkflowV2WorkflowPage>> {
  return request<WorkflowV2WorkflowPage>(WORKFLOWS_PATH, {
    method: "GET",
    query: { page: query.page, size: query.size, name: query.name },
    signal: options.signal,
  });
}

/**
 * 创建并登记工作流。
 *
 * 失败码按分支处理：未绑定租户 App 是 409 `ORG_APP_NOT_BOUND`（先绑定再创建），绑定降级是 503
 * `PLATFORM_ACCOUNT_DEGRADED`（暂时不可用、可重试），上游失败是 502 `UPSTREAM_*`。
 */
export function createWorkflow(
  input: WorkflowV2CreateInput,
  options: WorkflowRequestOptions = {},
): Promise<ApiResponse<WorkflowV2CreatedWorkflow>> {
  return request<WorkflowV2CreatedWorkflow>(WORKFLOWS_PATH, {
    method: "POST",
    body: input,
    signal: options.signal,
  });
}

/** 更新元数据（本页只用来改名）；`id` 是**本地 id**，服务端据此查记录再取上游 id。 */
export function updateWorkflow(
  id: string,
  patch: WorkflowV2UpdateInput,
  options: WorkflowRequestOptions = {},
): Promise<ApiResponse<{ readonly ok: true }>> {
  return request<{ readonly ok: true }>(`${WORKFLOWS_PATH}/:id`, {
    method: "PATCH",
    params: { id },
    body: patch,
    signal: options.signal,
  });
}

/**
 * 删除工作流（软删 + 尽力删上游）。
 *
 * 不给 `force`：跳过删除策略是绕过上游的安全动作（首发审核中 / 需先下架），本页只如实呈现拒绝原因，
 * 由用户在画布内完成下架后重试。
 */
export function deleteWorkflow(
  id: string,
  options: WorkflowRequestOptions = {},
): Promise<ApiResponse<WorkflowV2DeleteResult>> {
  return request<WorkflowV2DeleteResult>(`${WORKFLOWS_PATH}/:id`, {
    method: "DELETE",
    params: { id },
    signal: options.signal,
  });
}
