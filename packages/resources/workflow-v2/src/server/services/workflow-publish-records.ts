/**
 * 控制面「发布记录 + 上游当前发布版本」的**读路径**。
 *
 * 数据来源只有上游两处，本模块不落任何本地发布记录（用户口径：发布记录用上游的数据，平台侧无需第二份）：
 * - `POST /api/workflow_api/list_publish_workflow`：发布记录（上游白名单里的「发布记录」端点，见设计 §4.2）；
 *   请求用 `workflow_ids` 收窄到单个 workflow，`size` 是 thrift 必填（缺它上游回 HTTP 400，契约快照 §2 第 22 行）。
 * - `POST /api/workflow_api/canvas`：**当前发布版本**。上游没有独立的「当前版本」读接口
 *   （契约快照 F3：`workflow_detail.version` 发布前后均为空串、`history_schema` 缺有效 `commit_id` 时 panic），
 *   canvas 的 `data.workflow_version`（上游 `wf.LatestPublishedVersion`）是唯一可用来源。代价是这份响应同时带
 *   回整份 `schema_json`（大 workflow 可达数百 KB），我们只读一个字段、其余即弃——换取「状态以上游为准」，
 *   不为此新增本地版本镜像（本地 `published_version` 只服务版本自增，见 `workflow-publish.ts` 文件头）。
 *
 * **已知缺口（部署方需知情）**：当前关联上游构建里 `list_publish_workflow` 是桩实现
 * （`backend/api/handler/coze/workflow_service.go` 的 `ListPublishWorkflow` 直接返回空结构体），实测返回
 * `data: null`；因此本接口在现行上游上记录列表**恒为空**，UI 必须把它当合法空态呈现，而不是当失败。
 * 记录非空的前提是上游补齐该端点（上游侧发布记录属于 App 上架审核链路，超出工作流发布范围）。
 *
 * 失败语义与写路径同口径：传输/会话失败**原样抛**，由控制面的统一失败映射转 502/503/504
 * （`routes/web/workflow-http.ts`）；上游业务失败（`code≠0` / 非 2xx）由本模块如实带回原始结果，路由层再映射。
 */

import { createLogger } from "@fenix/logger";
import { callUpstream, type UpstreamCallInput, type UpstreamCallResult } from "./upstream-client";

const logger = createLogger("wf2-publish-records");

/** 上游发布记录端点（白名单内的既有端点，不新增上游路径）。 */
const LIST_PUBLISH_PATH = "/api/workflow_api/list_publish_workflow";
/** 上游画布端点：本模块只取其中的 `workflow_version`。 */
const CANVAS_PATH = "/api/workflow_api/canvas";

/** 一次读取的发布记录条数上界：单个 workflow 的记录不会多，超出部分不翻页（列表不以条数取胜）。 */
const RECORD_PAGE_SIZE = 20;

/**
 * 发布记录条目（归一化后）。
 *
 * 上游 `PublishBasicWorkflowData` 里带连接器聚合、token 消耗等字段，控制台不消费，因此**不搬运**
 * （协议 DTO 与视图模型在边界处独立转换）：只保留能回答「这个 workflow 什么时候发布的、谁发布的」的三项。
 * 上游缺失的字段一律为 null，不造默认值、不省略键（前端类型据此一一对应）。
 */
export interface WorkflowPublishRecord {
  /** 记录对应的上游 workflow ID；上游未回时为 null（此时该条记录不参与本 workflow 的过滤，见下）。 */
  readonly workflowId: string | null;
  readonly name: string | null;
  /** 发布时间（ISO 8601，UTC）；上游未回时为 null。 */
  readonly publishedAt: string | null;
  /** 发布者（上游用户 ID 串）；上游未回时为 null。 */
  readonly ownerId: string | null;
}

/** 发布概况：上游当前发布版本 + 上游发布记录。 */
export interface WorkflowPublishOverview {
  readonly current: {
    /** 上游记录的当前发布版本（canvas `WorkflowVersion`）；上游未发布或未回该字段时为 null。 */
    readonly publishedVersion: string | null;
  };
  readonly records: readonly WorkflowPublishRecord[];
}

/**
 * 读取结果：上游业务失败如实带回原始响应，由路由层映射；传输层失败直接抛（见文件头）。
 */
export type WorkflowPublishOverviewOutcome =
  | { readonly ok: true; readonly overview: WorkflowPublishOverview }
  | { readonly ok: false; readonly result: UpstreamCallResult };

/** 上游调用端口；与 `callUpstream` 同形，缺省即真实实现（测试注入替身，不触达真实上游与会话）。 */
export type WorkflowPublishOverviewUpstreamCall = (input: UpstreamCallInput) => Promise<UpstreamCallResult>;

export interface WorkflowPublishOverviewInput {
  /** 上游 workflow ID（本模块的查询主体，客户端的本地主键不进这里）。 */
  readonly upstreamWorkflowId: string;
  /** 注入的 `space_id`（平台个人空间）；客户端自报的同名字段不参与。 */
  readonly spaceId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 上游业务成功 = HTTP 200 且 `code === 0`（与写路径 `workflow-publish.ts` 同口径）。 */
function isUpstreamSuccess(result: UpstreamCallResult): boolean {
  return result.status === 200 && isRecord(result.body) && result.body.code === 0;
}

/** 读嵌套字段；路径不存在或值不是对象时返回 null。 */
function readPath(body: unknown, path: readonly string[]): unknown {
  let current: unknown = body;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return current ?? null;
}

/** 非空字符串才算「有值」：上游对未设置的字符串字段既可能省略也可能回空串，两者都归一成 null。 */
function readNonEmptyString(body: unknown, path: readonly string[]): string | null {
  const value = readPath(body, path);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 上游时间戳 → ISO 串。
 *
 * 单位无法从契约确认（thrift 里只有 `Int64`；同一份 IDL 的 `create_time`/`update_time` 在上游实现里是
 * **秒**，但发布记录端点没有可对照的非空样本）。这里按量级判别：`≥ 10^11` 视为毫秒，否则视为秒——两个
 * 单位都能得到合理时间，而不是把秒当毫秒显示成 1970、或把毫秒当秒显示成五万年后的日期。落库/上屏形状统一
 * 为 ISO 串，前端不猜单位。
 */
const EPOCH_MILLISECONDS_THRESHOLD = 1e11;

function toIsoString(body: unknown, path: readonly string[]): string | null {
  const value = readPath(body, path);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value >= EPOCH_MILLISECONDS_THRESHOLD ? value : value * 1000;
  return new Date(milliseconds).toISOString();
}

/**
 * `data.workflows[]` → 发布记录。
 *
 * 只认 `workflow_ids` 过滤**之后**仍属于本 workflow 的条目：上游的 `workflow_ids` 是可选过滤字段，若它被
 * 忽略（或未来语义变化），不过滤就会把别的 workflow 的记录显示在本 workflow 名下——那比空列表更糟。
 * 上游未回 `basic_info.id` 的条目无从判断归属，如实保留（此时对话框的条数由上游决定，不做本地猜测）。
 */
function readRecords(body: unknown, upstreamWorkflowId: string): WorkflowPublishRecord[] {
  const raw = readPath(body, ["data", "workflows"]);
  if (!Array.isArray(raw)) return [];
  const records: WorkflowPublishRecord[] = [];
  for (const entry of raw) {
    const workflowId = readNonEmptyString(entry, ["basic_info", "id"]);
    if (workflowId !== null && workflowId !== upstreamWorkflowId) continue;
    records.push({
      workflowId,
      name: readNonEmptyString(entry, ["basic_info", "name"]),
      publishedAt: toIsoString(entry, ["basic_info", "publish_time"]),
      ownerId: readNonEmptyString(entry, ["basic_info", "owner_id"]),
    });
  }
  return records;
}

/**
 * 读取发布概况：先取发布记录（本接口的主体），再取 canvas 的当前发布版本。
 *
 * 为什么 canvas 失败不做降级：它是「以上游为准」的那一半状态，静默降级成「未知」会让对话框看起来正常、
 * 实际少一半事实（前端拿 `current.publishedVersion` 与本地登记版本比对漂移，缺了它比对就无效）。
 * 失败如实返回，用户手里的「重试」就是恢复动作。
 */
export async function fetchWorkflowPublishOverview(
  input: WorkflowPublishOverviewInput,
  options: { readonly callUpstream?: WorkflowPublishOverviewUpstreamCall } = {},
): Promise<WorkflowPublishOverviewOutcome> {
  const upstream = options.callUpstream ?? callUpstream;

  const recordsResult = await upstream({
    path: LIST_PUBLISH_PATH,
    body: {
      // space_id / owner_id 由服务端注入：owner 收窄为平台账号（平台账号是上游唯一用户），客户端自报值不参与。
      space_id: input.spaceId,
      workflow_ids: [input.upstreamWorkflowId],
      size: RECORD_PAGE_SIZE,
    },
  });
  if (!isUpstreamSuccess(recordsResult)) {
    logger.warn("workflow-v2 读取发布记录失败", {
      upstreamWorkflowId: input.upstreamWorkflowId,
      upstreamStatus: recordsResult.status,
      upstreamCode: readPath(recordsResult.body, ["code"]),
    });
    return { ok: false, result: recordsResult };
  }

  const canvasResult = await upstream({
    path: CANVAS_PATH,
    body: { workflow_id: input.upstreamWorkflowId, space_id: input.spaceId },
  });
  if (!isUpstreamSuccess(canvasResult)) {
    logger.warn("workflow-v2 读取上游发布版本失败", {
      upstreamWorkflowId: input.upstreamWorkflowId,
      upstreamStatus: canvasResult.status,
      upstreamCode: readPath(canvasResult.body, ["code"]),
    });
    return { ok: false, result: canvasResult };
  }

  return {
    ok: true,
    overview: {
      current: { publishedVersion: readNonEmptyString(canvasResult.body, ["data", "workflow_version"]) },
      records: readRecords(recordsResult.body, input.upstreamWorkflowId),
    },
  };
}
