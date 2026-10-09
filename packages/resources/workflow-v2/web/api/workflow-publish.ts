// web/api/workflow-publish.ts
// 列表页「发布」动作与「日志」弹窗的域模块（冻结 §4.3 的 `/web/workflow-v2/workflows*` 控制面）。
//
// 两条端点都按**本地主键**寻址（`/workflows/:id/...`）：归属与组织隔离由服务端按本地注册表判定，客户端不
// 参与身份拼装。
//
// 发布记录**全部来自上游**（服务端转发 `list_publish_workflow` 与 canvas 的当前发布版本），平台侧不落任何发布
// 日志——本层因此不缓存、不合并本地状态：`records` 为空就是上游没有记录（合法空态），不是「还没加载」。
//
// 信封口径与 `workflows.ts` 同源：`request()` 已解掉 `{ success, data }` 一层，失败**返回** `{ success: false }`
// 而不 throw（§5.2），调用方必须 `unwrap()` 或显式判 `success`。文案属视图层：本层不带用户可见字符串。

import { type ApiResponse, request } from "@fenix/web-runtime/api/request";

/** 域路径前缀；与 `workflows.ts` 各自写全路径，不做跨文件的常量共享（两处消费点，改一处会静默漂移）。 */
const WORKFLOWS_PATH = "/web/workflow-v2/workflows";

/** 可取消调用的选项；页面在重试 / 卸载时 abort 在途请求（§3.4「主动取消用 signal」）。 */
export interface WorkflowPublishRequestOptions {
  readonly signal?: AbortSignal;
}

/** 发布入参：`description` 是版本说明，`force` 跳过上游「草稿必须先通过调试运行」的前置校验。 */
export interface WorkflowV2PublishInput {
  readonly description?: string;
  readonly force?: boolean;
}

/** 发布结果：`version` 由服务端生成（首发布 v0.0.1、其后 patch 自增），`commitId` 上游当前恒为空串。 */
export interface WorkflowV2PublishResult {
  readonly version: string;
  readonly commitId: string;
}

/**
 * 上游发布记录条目（服务端 `PublishRecordSchema` 逐字段对应）。
 *
 * 三项都可为 null：上游缺失的字段如实为 null，本层不造默认值、不省略键（禁止幻影字段）。
 */
export interface WorkflowV2PublishRecord {
  readonly workflowId: string | null;
  readonly name: string | null;
  /** ISO 8601 时间串；上游未回发布时间时为 null。 */
  readonly publishedAt: string | null;
  readonly ownerId: string | null;
}

/** 发布概况：上游记录的当前发布版本 + 上游发布记录（两项都不是本地数据）。 */
export interface WorkflowV2PublishOverview {
  readonly current: {
    /** 上游当前发布版本；未发布时为 null。 */
    readonly publishedVersion: string | null;
  };
  readonly records: readonly WorkflowV2PublishRecord[];
}

/**
 * 发布一个新版本（本地主键寻址）。
 *
 * 失败码按分支处理：未绑定租户 App 409 `ORG_APP_NOT_BOUND`、绑定降级 503 `PLATFORM_ACCOUNT_DEGRADED`、
 * 上游业务拒绝 409（`WORKFLOW_DRAFT_NOT_VERIFIED` / `WORKFLOW_VERSION_NOT_INCREMENTAL` /
 * `WORKFLOW_VERSION_INVALID`）或 502 `UPSTREAM_*`，文案由 UI 按码取字典（§9.3）。
 */
export function publishWorkflow(
  id: string,
  input: WorkflowV2PublishInput = {},
  options: WorkflowPublishRequestOptions = {},
): Promise<ApiResponse<WorkflowV2PublishResult>> {
  return request<WorkflowV2PublishResult>(`${WORKFLOWS_PATH}/:id/publish`, {
    method: "POST",
    params: { id },
    body: input,
    signal: options.signal,
  });
}

/**
 * 读取发布概况（上游数据经服务端转发；`records` 为空数组表示上游没有记录）。
 *
 * 供列表页的「日志」弹窗使用：它同时回答「上游现在认的版本」与「上游记录过哪些发布」，两项都不是本地数据，
 * 因此本层不缓存、不合并本地状态。
 */
export function fetchPublishOverview(
  id: string,
  options: WorkflowPublishRequestOptions = {},
): Promise<ApiResponse<WorkflowV2PublishOverview>> {
  return request<WorkflowV2PublishOverview>(`${WORKFLOWS_PATH}/:id/publish-records`, {
    method: "GET",
    params: { id },
    signal: options.signal,
  });
}
