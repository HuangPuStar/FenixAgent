// web/api/workflow-publish.ts
// 「发布日志」弹窗的域模块（冻结 §4.3 的 `/web/workflow-v2/workflows*` 控制面）。
// 控制台发布入口已撤除：发布动作在上游侧完成（画布 / 上游控制台），平台只读发布概况。
//
// 两条端点都按**本地主键**寻址（`/workflows/:id/...`）：归属与组织隔离由服务端按本地注册表判定，客户端不
// 参与身份拼装。
//
// 发布概况有三段（服务端一次返回，字段一一对应）：
// - `current`：上游当前发布版本（canvas 的 `workflow_version`）；
// - `records`：**上游渠道发布记录**（应用级读出口 `intelligence_api/publish/publish_record_list`；工作流级的
//   `list_publish_workflow` 在该上游构建里是桩实现，见服务端 `workflow-publish-records.ts` 的文件头）；
// - `actions`：**平台侧发布动作**（本地审计流水：时间、操作人、结果），回答「我在控制台点过的发布结果如何」。
// 本层不缓存、不合并：某一段为空就是那一侧确实没有记录（合法空态），不是「还没加载」。
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

/** 渠道发布结果（服务端 `PublishChannelSchema` 逐字段对应）：渠道名 + 该渠道的发布状态。 */
export interface WorkflowV2PublishChannel {
  readonly connectorId: string | null;
  readonly connectorName: string | null;
  readonly status: "success" | "failed" | "auditing" | "in_progress" | "disabled" | null;
}

/**
 * 渠道发布记录条目（服务端 `PublishRecordSchema` 逐字段对应）。
 *
 * 上游记录**没有时间与操作人**（thrift 无这两个字段），因此这里也不给；`status` 由渠道结果与打包失败明细
 * 派生（上游记录级 `publish_status` 在该构建恒为 0，不可用）。
 */
export interface WorkflowV2PublishRecord {
  readonly version: string | null;
  readonly status: "done" | "pack_failed" | "in_progress";
  readonly channels: readonly WorkflowV2PublishChannel[];
  /** 打包失败涉及的上游对象名。 */
  readonly packFailedResources: readonly string[];
}

/** 平台侧发布动作（本地审计流水的一行）。 */
export interface WorkflowV2PublishAction {
  /** ISO 8601 时间串。 */
  readonly occurredAt: string;
  /** 操作人展示名；名录读不到或用户已删时为 null。 */
  readonly actorName: string | null;
  /** 归一化结果：`ok` / `upstream_rejected` / `failed` / `upstream_unavailable` … */
  readonly result: string;
  readonly errorCode: string | null;
}

/** 发布概况：上游当前版本 + 上游渠道发布记录 + 平台侧发布动作。 */
export interface WorkflowV2PublishOverview {
  readonly current: {
    /** 上游当前发布版本；未发布时为 null。 */
    readonly publishedVersion: string | null;
  };
  readonly records: readonly WorkflowV2PublishRecord[];
  readonly actions: readonly WorkflowV2PublishAction[];
}

/**
 * 读取发布概况（服务端一次返回三段：当前版本、上游渠道发布记录、平台侧发布动作）。
 *
 * 供列表页的「日志」弹窗使用：它同时回答「上游现在认的版本」「上游把哪些版本发布到渠道」「平台侧点过哪些
 * 发布、结果如何」，三段来源不同（上游 / 本地审计），本层原样透传、不合并。
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
