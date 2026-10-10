/**
 * 控制面「发布日志」的**读路径**：上游当前发布版本 + 上游渠道发布记录 + 平台侧发布动作。
 *
 * ## 数据来源与选型（2026-10-09 穷尽核对上游路由表与上游前端调用点）
 *
 * 上游里「按 workflow 列发布记录」的端点 `POST /api/workflow_api/list_publish_workflow` 与
 * `POST /api/workflow_api/released_workflows` 在当前关联构建里都是**桩实现**
 * （`backend/api/handler/coze/workflow_service.go:793` / `:236` 只做参数绑定后返回空结构体；实测带真实
 * workflow 仍回 `data:null`），且上游前端**根本不调用** `list_publish_workflow`。
 *
 * 真正有数据、且上游自己的控制台在用的发布记录读出口是**应用级**的：
 * `POST /api/intelligence_api/publish/publish_record_list`（上游
 * `frontend/packages/studio/workspace/project-publish/src/hooks/use-publish-status.tsx:150` 调
 * `intelligenceApi.GetPublishRecordList`；实测返回版本号 + 渠道发布结果 + 打包失败明细）。
 * 平台侧的租户 workflow 就挂在租户应用下，因此这些记录正是「把该工作流的版本发布到渠道」的事件序列。
 *
 * 另外两处**上游不可得**、但平台自己持有的诚实来源，作为 `actions` 一并给出（控制台用户真正关心的是
 * 「我在控制台点过的发布结果如何」；上游只记录发布产物，不记录控制台动作）：
 * - `workflow_v2_audit_log` 的 `workflow.publish` 行：时间 + 操作人 + 归一化结果（本地表，读失败只降级该段）。
 *
 * ## 上游字段的可用性（不显示幻造字段）
 *
 * - `version_number` ✓、`connector_publish_result[]`（渠道 id/名称/状态）✓、`publish_status_detail.pack_failed_detail[]` ✓；
 * - `publish_status`（记录级状态）在该构建里**恒为 0**（上游 `GetPublishRecordList` 未 hydrate 应用行状态，
 *   实测与库里 `app_release_record.publish_status` 的 5/1 不一致）→ **不显示**，改为由渠道结果与打包明细
 *   派生一个保守的三态（见 {@link deriveRecordStatus}）；
 * - 记录里**没有时间**字段（thrift `PublishRecordDetail` 无 create_time）→ 不显示时间，不猜。
 *
 * 失败语义与写路径同口径：传输/会话失败**原样抛**，由控制面的统一失败映射转 502/503/504
 * （`routes/web/workflow-http.ts`）；上游业务失败（`code≠0` / 非 2xx）如实带回原始结果，路由层再映射。
 */

import { createLogger } from "@fenix/logger";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { workflowV2AuditLog } from "@fenix/resource-workflow-v2/db";
import { and, desc, eq } from "drizzle-orm";
import { getWorkflowV2Database } from "../repositories/database";
import { callUpstream, type UpstreamCallInput, type UpstreamCallResult } from "./upstream-client";

const logger = createLogger("wf2-publish-records");

/** 应用级发布记录端点（上游控制台在用的真实读出口，见文件头）。 */
const PUBLISH_RECORD_LIST_PATH = "/api/intelligence_api/publish/publish_record_list";
/** 上游画布端点：本模块只取其中的 `workflow_version`（当前发布版本）。 */
const CANVAS_PATH = "/api/workflow_api/canvas";
/** 控制台发布动作的审计动作名（与 `audit-trail.ts` 同字面量；从那里 import 会形成服务间环，故本地声明并登记）。 */
const PUBLISH_ACTION = "workflow.publish";

/** 上游渠道发布状态码 → 平台稳定取值（上游 `ConnectorPublishStatus`）。 */
export type WorkflowPublishChannelStatus = "success" | "failed" | "auditing" | "in_progress" | "disabled";

/** 一条渠道发布结果（只搬运控制台展示所需的字段）。 */
export interface WorkflowPublishChannelResult {
  readonly connectorId: string | null;
  readonly connectorName: string | null;
  readonly status: WorkflowPublishChannelStatus | null;
}

/**
 * 记录级状态：由**真实可得**的字段派生（记录级 `publish_status` 在该构建恒为 0，不可用）。
 *
 * - `pack_failed`：上游给了打包失败明细（`pack_failed_detail` 非空）；
 * - `done`：至少一个渠道且全部 `success`；
 * - `in_progress`：其余情况（含渠道未给终态、无渠道）——不把不确定说成成功或失败。
 */
export type WorkflowPublishRecordStatus = "done" | "pack_failed" | "in_progress";

/** 一条发布记录（归一化后）。 */
export interface WorkflowPublishRecord {
  readonly version: string | null;
  readonly status: WorkflowPublishRecordStatus;
  readonly channels: readonly WorkflowPublishChannelResult[];
  /** 打包失败涉及的上游对象名（工作流/插件），空数组表示上游未给出打包失败信息。 */
  readonly packFailedResources: readonly string[];
}

/** 平台侧发布动作（审计流水的一行）。 */
export interface WorkflowPublishAction {
  /** 发生时间（ISO 8601，UTC）。 */
  readonly occurredAt: string;
  /** 操作人展示名；名录读不到或用户已删时为 null（此时前端只显示时间与结果）。 */
  readonly actorName: string | null;
  /** 归一化结果：`ok` / `upstream_rejected` / `failed` / `upstream_unavailable` … */
  readonly result: string;
  /** 我方错误码（如 `WORKFLOW_VERSION_UNPARSEABLE`）；成功为 null。 */
  readonly errorCode: string | null;
}

/** 发布概况：上游当前发布版本 + 上游渠道发布记录 + 平台侧发布动作。 */
export interface WorkflowPublishOverview {
  readonly current: {
    /** 上游记录的当前发布版本（canvas `WorkflowVersion`）；上游未发布或未回该字段时为 null。 */
    readonly publishedVersion: string | null;
  };
  readonly records: readonly WorkflowPublishRecord[];
  readonly actions: readonly WorkflowPublishAction[];
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
  /** 该 workflow 所属的上游应用 ID（渠道发布记录的查询键，取自本地注册表）。 */
  readonly appId: string;
  /** 注入的 `space_id`（平台个人空间）；客户端自报的同名字段不参与。 */
  readonly spaceId: string;
  /** 组织 ID：平台侧动作从本组织的审计流水里读（多租户隔离的谓词）。 */
  readonly organizationId: string;
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

/** 渠道状态码 → 稳定取值；认不出的码返回 null（不猜）。 */
function toChannelStatus(value: unknown): WorkflowPublishChannelStatus | null {
  if (typeof value !== "number") return null;
  switch (value) {
    case 0:
      return "in_progress";
    case 1:
      return "auditing";
    case 2:
      return "success";
    case 3:
      return "failed";
    case 4:
      return "disabled";
    default:
      return null;
  }
}

/** 读一条记录里的渠道结果数组。 */
function readChannels(entry: unknown): WorkflowPublishChannelResult[] {
  const raw = readPath(entry, ["connector_publish_result"]);
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    connectorId: readNonEmptyString(item, ["connector_id"]),
    connectorName: readNonEmptyString(item, ["connector_name"]),
    status: toChannelStatus(readPath(item, ["connector_publish_status"])),
  }));
}

/** 读打包失败明细里的资源名（上游 `pack_failed_detail[].entity_name`）。 */
function readPackFailedResources(entry: unknown): string[] {
  const raw = readPath(entry, ["publish_status_detail", "pack_failed_detail"]);
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => readNonEmptyString(item, ["entity_name"])).filter((name): name is string => name !== null);
}

/** 由真实字段派生记录状态（见 {@link WorkflowPublishRecordStatus} 的说明）。 */
function deriveRecordStatus(
  channels: readonly WorkflowPublishChannelResult[],
  packFailed: readonly string[],
): WorkflowPublishRecordStatus {
  if (packFailed.length > 0) return "pack_failed";
  if (channels.length > 0 && channels.every((channel) => channel.status === "success")) return "done";
  return "in_progress";
}

/** `data[]` → 发布记录（倒序：上游按记录 id 升序返回，控制台按「最近发布优先」展示）。 */
function readRecords(body: unknown): WorkflowPublishRecord[] {
  const raw = readPath(body, ["data"]);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const channels = readChannels(entry);
      const packFailedResources = readPackFailedResources(entry);
      return {
        version: readNonEmptyString(entry, ["version_number"]),
        status: deriveRecordStatus(channels, packFailedResources),
        channels,
        packFailedResources,
      } satisfies WorkflowPublishRecord;
    })
    .reverse();
}

/**
 * 读平台侧发布动作（本组织的审计流水，按时间倒序）。
 *
 * **永不抛错**：这是「平台自己看过什么」的补充段落，读失败只降级成空列表 + warn 日志，绝不影响上游数据的
 * 展示（对话框的主体是上游版本与渠道记录）。审计表与注册表同库，注册表读得通时它几乎不会单独失败。
 */
export async function listWorkflowPublishActions(
  organizationId: string,
  upstreamWorkflowId: string,
  limit = 20,
): Promise<WorkflowPublishAction[]> {
  let rows: Array<{
    actorUserId: string;
    result: string;
    errorCode: string | null;
    createdAt: Date;
  }>;
  try {
    rows = await getWorkflowV2Database()
      .select({
        actorUserId: workflowV2AuditLog.actorUserId,
        result: workflowV2AuditLog.result,
        errorCode: workflowV2AuditLog.errorCode,
        createdAt: workflowV2AuditLog.createdAt,
      })
      .from(workflowV2AuditLog)
      .where(
        and(
          eq(workflowV2AuditLog.organizationId, organizationId),
          eq(workflowV2AuditLog.action, PUBLISH_ACTION),
          eq(workflowV2AuditLog.upstreamWorkflowId, upstreamWorkflowId),
        ),
      )
      .orderBy(desc(workflowV2AuditLog.createdAt))
      .limit(limit);
  } catch (error) {
    logger.warn("workflow-v2 平台侧发布动作读取失败，仅展示上游数据", {
      organizationId,
      upstreamWorkflowId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  if (rows.length === 0) return [];

  // 操作人展示名：批量读名录，读不到就留 null（不把用户 ID 直接上屏，也不因名录故障丢弃整段）。
  const actorNames = new Map<string, string>();
  try {
    const directory = getIdentityDirectory();
    const infos = await directory.listUserDisplayInfo([...new Set(rows.map((row) => row.actorUserId))]);
    for (const [id, info] of infos) {
      const name = info.name?.trim();
      if (name !== undefined && name.length > 0) actorNames.set(id, name);
    }
  } catch (error) {
    logger.warn("workflow-v2 发布动作的操作人名录读取失败，仅展示时间与结果", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return rows.map((row) => ({
    occurredAt: row.createdAt.toISOString(),
    actorName: actorNames.get(row.actorUserId) ?? null,
    result: row.result,
    errorCode: row.errorCode,
  }));
}

/**
 * 读取发布概况：先取上游渠道发布记录（主体），再取 canvas 的当前发布版本，最后补平台侧发布动作。
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
    path: PUBLISH_RECORD_LIST_PATH,
    // project_id 由服务端从本地注册表注入：客户端自报值不参与（归属已由路由按组织谓词判定）。
    body: { project_id: input.appId },
  });
  if (!isUpstreamSuccess(recordsResult)) {
    logger.warn("workflow-v2 读取渠道发布记录失败", {
      upstreamWorkflowId: input.upstreamWorkflowId,
      appId: input.appId,
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
      records: readRecords(recordsResult.body),
      actions: await listWorkflowPublishActions(input.organizationId, input.upstreamWorkflowId),
    },
  };
}
