// web/api/workflow-runs.ts
// 列表页「运行日志」视图的域模块（`/web/workflow-v2/run-records` 控制面）。
//
// 两段数据：**运行清单**由服务端转发上游 `list_spans`（上游 2026-10-09 起为真实实现；此前曾临时只读直连上游库，
// 已按 ADR `2026-10-09-workflow-v2-upstream-db-read.md` 的移除条件删除）；**平台侧记录**来自本地审计
// （平台触发的运行）。
//
// 列表为空数组表示查询窗口内确实没有运行（合法空态，不是失败）；上游读取失败由服务端按统一错误映射成
// 502/503/504，本层因此不缓存、不合并本地状态，也不为缺失字段造默认值。
//
// 信封口径与 `workflows.ts` / `workflow-publish.ts` 同源：`request()` 已解掉 `{ success, data }` 一层，失败
// **返回** `{ success: false }` 而不 throw（§5.2），调用方必须 `unwrap()` 或显式判 `success`。文案属视图层：
// 本层不带用户可见字符串。

import { type ApiResponse, request } from "@fenix/web-runtime/api/request";

/** 端点路径；与同目录其它域模块各自写全路径，不做跨文件常量共享（改一处会静默漂移）。 */
const RUN_RECORDS_PATH = "/web/workflow-v2/run-records";

/** 可取消调用的选项；页面在重试 / 卸载时 abort 在途请求（§3.4「主动取消用 signal」）。 */
export interface WorkflowRunRequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * 运行记录条目（服务端 `RunRecordSchema` 逐字段对应）。
 *
 * 字段来自上游 `list_spans` 的 span 与 tags（映射口径见服务端 `services/workflow-run-records.ts` 文件头）：
 * 上游缺失的字段如实为 null，本层不造默认值、不省略键（禁止幻影字段）；`workflowId` / `workflowName` 是查询
 * 主体（span 不回工作流身份）。`mode` / `status` 认不出的取值由服务端归一成 null。
 */
export interface WorkflowV2RunRecord {
  /** 该次运行所属的上游 workflow ID（查询主体）。 */
  readonly workflowId: string | null;
  /** 展示名（本地注册表登记名）；本地查不到时为 null。 */
  readonly workflowName: string | null;
  /** 执行 ID（上游 `span_id`，即 `workflow_execution.id`）；缺失为 null。 */
  readonly executeId: string | null;
  /** 上游日志 ID（可回查调试页）；上游未记录时为 null。 */
  readonly logId: string | null;
  /** 发布版本；草稿运行为 null。 */
  readonly version: string | null;
  /** 运行模式：试运行 / 发布运行 / 节点调试。 */
  readonly mode: "debug" | "release" | "node_debug" | null;
  /** 执行状态；null 表示上游给了认不出的码（含义是「未知」）。 */
  readonly status: "running" | "succeeded" | "failed" | "canceled" | "interrupted" | null;
  /** 耗时（毫秒）；上游未回时为 null。 */
  readonly durationMs: number | null;
  /** 开始时间（ISO 8601）；上游未回时为 null。 */
  readonly createdAt: string | null;
  readonly errorCode: string | null;
  /** 节点数；上游未回时为 null。 */
  readonly nodeCount: number | null;
}

/** 筛选选项：组织内工作流（本地主键 + 名称）。 */
export interface WorkflowV2RunWorkflowOption {
  readonly id: string;
  readonly name: string;
}

/**
 * 运行日志视图的一次取数结果。
 *
 * `workflows` 与记录同批返回：筛选器的选项与列表是同一个视图的两半，拆成两个请求会多出一条独立的失败路径。
 * `scannedWorkflows` / `workflowTotal` 一起说明「全部工作流」的实际范围——上游按工作流查询，平台侧只能扇出
 * 有限个，界面据此说得出「这次没有覆盖全部工作流」。
 */
/**
 * 平台侧运行记录（服务端 `PlatformRunSchema` 逐字段对应）：平台自己触发的运行（对外接口）在审计流水里的留痕。
 *
 * 与上游 `items` 是两件事，必须分开展示：这里只有**平台触发**的运行（画布内的试运行不经过平台），字段是
 * 时间与结果；上游侧的 `logId`/`traceId`/耗时不在审计表里。
 */
export interface WorkflowV2PlatformRun {
  readonly upstreamWorkflowId: string | null;
  /** ISO 8601 时间串。 */
  readonly occurredAt: string;
  /** 归一化结果：`ok` / `upstream_rejected` / `upstream_unavailable` … */
  readonly result: string;
  readonly errorCode: string | null;
}

export interface WorkflowV2RunLogPage {
  /** 上游运行清单；空数组表示查询窗口内确实没有运行（合法空态，不是失败）。 */
  readonly items: readonly WorkflowV2RunRecord[];
  readonly platformRuns: readonly WorkflowV2PlatformRun[];
  readonly workflows: readonly WorkflowV2RunWorkflowOption[];
  readonly scannedWorkflows: number;
  readonly workflowTotal: number;
  /** 命中数超过上屏上界，列表已被裁剪。 */
  readonly truncated: boolean;
  /**
   * 上游可能还有更早的运行：至少一个目标本次返回的条数等于页大小（服务端按「页满」推断，上游没有游标，
   * 见 `services/workflow-run-records.ts` 的 `hasMoreUpstream`）。恰好一页时会有假阳性，因此文案说「可能」。
   */
  readonly hasMoreUpstream: boolean;
}

/**
 * 读取运行记录（`workflowId` 缺省＝全部工作流）。
 *
 * `workflowId` 取**本地主键**：归属与组织隔离由服务端按本地注册表判定，客户端不参与身份拼装，也不接触上游 ID。
 * 失败码：未绑定租户 App 409 `ORG_APP_NOT_BOUND`、绑定降级 503 `PLATFORM_ACCOUNT_DEGRADED`、筛选目标不可见
 * 404 `WORKFLOW_NOT_FOUND`、上游失败 502/503/504 `UPSTREAM_*`，文案由 UI 按码取字典（§9.3）。
 */
export function fetchRunRecords(
  query: { readonly workflowId?: string } = {},
  options: WorkflowRunRequestOptions = {},
): Promise<ApiResponse<WorkflowV2RunLogPage>> {
  return request<WorkflowV2RunLogPage>(RUN_RECORDS_PATH, {
    method: "GET",
    // 缺省时 `workflowId` 为 undefined，请求基建会跳过该 query 键（不产生 `?workflowId=`）。
    query: { workflowId: query.workflowId },
    signal: options.signal,
  });
}
