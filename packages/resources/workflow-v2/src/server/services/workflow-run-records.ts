/**
 * 控制面「运行日志」的**读路径**：把上游运行 span 转成平台视图模型。
 *
 * 数据来源只有上游一处（平台侧不落第二份运行记录），本模块不读也不写任何本地表：
 * - `POST /api/workflow_api/list_spans`：**运行列表**。`workflow_id` 必填，因此**一个工作流一次调用**；
 *   「全部工作流」由调用方（路由）解析成一组目标后在本模块合并。窗口 `start_at`/`end_at` 是**毫秒**，
 *   由本模块显式传（不依赖上游默认值）：`end_at = now`、`start_at = now − 7d`；`limit = 20`（上游钳制 0→20、
 *   >50→50）；`desc_by_start_time = true`。上游**不返回** `has_more`/游标，「还有更早的运行」只能按页满推断
 *   （见 {@link WorkflowRunRecords.hasMoreUpstream}）。
 * - 平台侧那一段（`platformRuns`）来自本地审计流水，见 {@link listPlatformRunRecords}。
 *
 * ## 上游契约（2026-10-09 源码核实，commit `3a028cf1`）
 *
 * 响应是**扁平结构** `{ code, msg, spans }`：`HTTP 2xx` 且 `code === 0` 才是成功（非 2xx 或 `code≠0` 是上游业务
 * 失败）。`spans[]` 的元素是 trace 级 `Span`，平台要的字段一半在 span 上、一半在 `tags` 里：
 *
 * | 平台字段 | 来源 | 说明 |
 * | --- | --- | --- |
 * | `executeId` | `span.span_id` | 上游 `workflow_execution.id` 的字符串形态（tags 里 `execute_id` 同值） |
 * | `logId` | `tags.log_id` | **取 tag 而不是 `span.log_id`**：span 侧在上游为空时用 span id 兜底（不是真实 log id） |
 * | `version` | `tags.version` | 空串 = 草稿运行 → null |
 * | `mode` | `tags.mode` | 1 试运行 / 2 发布运行 / 3 节点调试 |
 * | `status` | `tags.status` | 上游 `WorkflowExeStatus` 原值：1 运行中 / 2 成功 / 3 失败 / 4 取消 / 5 中断 |
 * | `durationMs` | `tags.duration`（回退 `span.duration`） | 毫秒 |
 * | `createdAt` | `tags.created_at`（回退 `span.start_time`） | 毫秒 → ISO 8601 |
 * | `errorCode` | `tags.error_code` | 空串 = 无错误 → null |
 * | `nodeCount` | `tags.node_count` | 节点数 |
 * | `workflowId` / `workflowName` | **查询主体**（本地注册表） | 上游 span 不回工作流身份与展示名 |
 *
 * `span.status_code` 只有「成功 0 / 其余 1」两档，精度不如 `tags.status`，因此**不消费**它（显示口径以 tags 为准）。
 *
 * 失败语义与其它控制面读路径同口径：传输/会话失败**原样抛**，由控制面的统一失败映射转 502/503/504
 * （`routes/web/workflow-http.ts`）；上游业务失败（非 2xx / `code≠0`）由本模块如实带回原始结果，路由层再映射。
 * **任一目标失败即整批失败**：部分成功会静默少显示某些工作流的记录，用户看到的是「这些工作流没有运行过」，
 * 而事实是「没读到」——那只比重试更糟。
 */

import { createLogger } from "@fenix/logger";
import { workflowV2AuditLog } from "@fenix/resource-workflow-v2/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getWorkflowV2Database } from "../repositories/database";
import { callUpstream, type UpstreamCallInput, type UpstreamCallResult } from "./upstream-client";

const logger = createLogger("wf2-run-records");

/** 上游运行 span 列表端点（走会话通道；上游 2026-10-09 起为真实实现）。 */
const LIST_SPANS_PATH = "/api/workflow_api/list_spans";

/** 单个工作流一次读取的 span 条数（上游默认值与上界之间的保守取值：0→20、>50→50）。 */
const SPAN_PAGE_SIZE = 20;

/** 查询窗口：最近 7 天。窗口由服务端决定，客户端不能自定义（避免把上游查询变成任意时间范围扫描）。 */
const QUERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 上屏记录条数上界：本视图是对话框、不做翻页，超出部分裁掉并置 `truncated`。 */
export const RUN_RECORD_LIMIT = 50;

/** 运行模式：与上游 `workflow_execution.mode` 的取值一致（1 试运行 / 2 发布运行 / 3 节点调试）。 */
export type WorkflowRunMode = "debug" | "release" | "node_debug";

/**
 * 运行状态：与上游 `WorkflowExeStatus`（`workflow_execution.status` 原值）一致。
 *
 * 1 运行中 / 2 成功 / 3 失败 / 4 取消 / 5 中断；认不出的取值由解析层归一成 null（不猜）。
 */
export type WorkflowRunStatus = "running" | "succeeded" | "failed" | "canceled" | "interrupted";

/**
 * 运行记录条目（归一化后）。
 *
 * 上游缺失的字段一律为 null，不造默认值、不省略键（前端类型据此一一对应）。`workflowId` / `workflowName`
 * 是**查询主体**而非上游回值（span 不带工作流身份）。
 */
export interface WorkflowRunRecord {
  /** 该次运行所属的上游 workflow ID（查询主体）。 */
  readonly workflowId: string | null;
  /** 展示名：本地注册表登记的 workflow 名；本地查不到时为 null。 */
  readonly workflowName: string | null;
  /** 执行 ID（上游 `span_id`，即 `workflow_execution.id`）；缺失为 null。 */
  readonly executeId: string | null;
  /** 上游日志 ID（`tags.log_id`，可回查调试页）；上游未记录时为 null。 */
  readonly logId: string | null;
  /** 发布版本（`tags.version`）；草稿运行为 null。 */
  readonly version: string | null;
  readonly mode: WorkflowRunMode | null;
  readonly status: WorkflowRunStatus | null;
  /** 耗时（毫秒）；上游未回时为 null。 */
  readonly durationMs: number | null;
  /** 开始时间（ISO 8601，UTC）；上游未回时为 null。 */
  readonly createdAt: string | null;
  /** 上游错误码；成功为 null。 */
  readonly errorCode: string | null;
  /** 节点数；上游未回时为 null。 */
  readonly nodeCount: number | null;
}

/** 平台侧运行记录：平台自己触发的运行（对外接口）在 `workflow_v2_audit_log` 里的留痕。 */
export interface PlatformRunRecord {
  /** 上游 workflow ID（审计行按它归属；异常数据里可能为空）。 */
  readonly upstreamWorkflowId: string | null;
  /** 触发时间（ISO 8601，UTC）。 */
  readonly occurredAt: string;
  /** 归一化结果：`ok` / `upstream_rejected` / `upstream_unavailable` … */
  readonly result: string;
  /** 我方错误码（如 `WORKFLOW_NOT_REGISTERED_TO_API_CHANNEL`）；成功为 null。 */
  readonly errorCode: string | null;
}

/** 平台侧运行记录的审计动作名（与 `audit-trail.ts` 同字面量；从那里 import 会形成服务间环）。 */
const RUN_EXTERNAL_ACTION = "workflow.run.external";

export interface WorkflowRunRecords {
  readonly items: readonly WorkflowRunRecord[];
  /** 命中条数超过 {@link RUN_RECORD_LIMIT}，列表已被裁剪（UI 据此给出「只显示最近 N 条」的说明）。 */
  readonly truncated: boolean;
  /**
   * 上游可能还有更早的运行：**任一目标**本次返回的 span 数等于请求页大小（{@link SPAN_PAGE_SIZE}）即为真。
   *
   * 页满是一个**推断**而不是上游的声明：该端点没有 `has_more`/游标，只有 `limit`/`offset`，而页满说明这个
   * 工作流在窗口内的运行数**至少**是页大小，更早的记录没被这一页装下。取「任一目标」而非「全部目标」：这条
   * 标志回答的是「这份清单是否可能少了东西」，只要有一个工作流被截断，答案就是「可能」。它与
   * {@link truncated}（平台侧上屏裁剪）互不替代，两者可以同时为真。
   *
   * 已知假阳性：某工作流在窗口内**恰好**有页大小条运行时会置真（上游不区分「正好装满」与「被裁掉」）。因此
   * 提示文案说「可能还有」而不是断言还有——少提示会让用户把「只有一页」读成「一共就这么多」，而那是错的。
   */
  readonly hasMoreUpstream: boolean;
  /** 平台侧触发的运行（审计留痕，见 {@link PlatformRunRecord}）；与上游清单是两件事，分开展示。 */
  readonly platformRuns: readonly PlatformRunRecord[];
}

/** 查询目标：一个工作流一次上游调用（`workflow_id` 是上游必填）。 */
export interface WorkflowRunTarget {
  readonly upstreamWorkflowId: string;
  /** 本地登记名；本地查不到时给 null，展示层再兜底。 */
  readonly name: string | null;
}

export interface WorkflowRunRecordsInput {
  /** 组织 ID：平台侧运行记录从本组织的审计流水里读（多租户隔离的谓词）。 */
  readonly organizationId: string;
  /** 查询目标集（≤ 路由层的上界常量，同时即本模块的并发上界）。 */
  readonly targets: readonly WorkflowRunTarget[];
  /** 查询窗口终点（毫秒）；缺省取当前时间。 */
  readonly endAtMs?: number;
}

/**
 * 读取结果：上游业务失败如实带回原始响应，由路由层映射；传输层失败直接抛（见文件头）。
 */
export type WorkflowRunRecordsOutcome =
  | { readonly ok: true; readonly records: WorkflowRunRecords }
  | { readonly ok: false; readonly result: UpstreamCallResult };

/** 上游调用端口；与 `callUpstream` 同形，缺省即真实实现（测试注入替身，不触达真实上游与会话）。 */
export type WorkflowRunRecordsUpstreamCall = (input: UpstreamCallInput) => Promise<UpstreamCallResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * span 上的 tags → `key → {str, long}`；tags 缺失或形状不符时返回空表。
 *
 * tags 的取值按 `tag_type` 分列在 `value.v_str` / `value.v_long`，这里把两种都读出来，由调用方按字段语义取用
 * （不按 `tag_type` 分支：上游的类型标注对展示没有影响，取值形状才是事实）。
 */
function readTags(span: unknown): Map<string, { readonly str: string | null; readonly long: number | null }> {
  const tags = new Map<string, { str: string | null; long: number | null }>();
  const raw = readPath(span, ["tags"]);
  if (!Array.isArray(raw)) return tags;
  for (const tag of raw) {
    const key = readNonEmptyString(tag, ["key"]);
    if (key === null) continue;
    const rawStr = readPath(tag, ["value", "v_str"]);
    const rawLong = readPath(tag, ["value", "v_long"]);
    const asLong = typeof rawLong === "number" ? rawLong : typeof rawLong === "string" ? Number(rawLong) : Number.NaN;
    tags.set(key, {
      str: typeof rawStr === "string" && rawStr.length > 0 ? rawStr : null,
      long: Number.isFinite(asLong) ? asLong : null,
    });
  }
  return tags;
}

/** 读 span 本身的毫秒时间戳：只接受有限正数，其余一律 null（不猜单位：该端点标注就是毫秒）。 */
function readSpanMilliseconds(span: unknown, key: string): number | null {
  const value = readPath(span, [key]);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 运行模式码 → 稳定取值；认不出的码返回 null（不猜）。 */
function toMode(value: number | null): WorkflowRunMode | null {
  if (value === 1) return "debug";
  if (value === 2) return "release";
  if (value === 3) return "node_debug";
  return null;
}

/** 状态码 → 稳定取值（上游 `WorkflowExeStatus` 原值）；认不出的码返回 null（不猜）。 */
function toStatus(value: number | null): WorkflowRunStatus | null {
  if (value === 1) return "running";
  if (value === 2) return "succeeded";
  if (value === 3) return "failed";
  if (value === 4) return "canceled";
  if (value === 5) return "interrupted";
  return null;
}

/** 毫秒时间戳 → ISO 串；非法值返回 null。 */
function toIsoString(milliseconds: number | null): string | null {
  if (milliseconds === null || milliseconds <= 0) return null;
  return new Date(milliseconds).toISOString();
}

/** 单条 span → 平台视图模型；`target` 补上上游不回的身份字段（见文件头的字段来源表）。 */
function toRunRecord(span: unknown, target: WorkflowRunTarget): WorkflowRunRecord {
  const tags = readTags(span);
  const tag = (key: string) => tags.get(key) ?? { str: null, long: null };
  const startedAtMs = tag("created_at").long ?? readSpanMilliseconds(span, "start_time");

  return {
    workflowId: target.upstreamWorkflowId,
    workflowName: target.name,
    executeId: readNonEmptyString(span, ["span_id"]) ?? tag("execute_id").str,
    // 只认 tag：span 侧在上游为空时会用 span id 兜底，那不是真实 log id。
    logId: tag("log_id").str,
    version: tag("version").str,
    mode: toMode(tag("mode").long),
    status: toStatus(tag("status").long),
    durationMs: tag("duration").long ?? readSpanMilliseconds(span, "duration"),
    createdAt: toIsoString(startedAtMs),
    errorCode: tag("error_code").str,
    nodeCount: tag("node_count").long,
  };
}

/**
 * 排序：开始时间倒序（ISO 串按字典序比较即时间序，null 排在最后），再按 workflow / 执行 ID 升序定序以消除
 * 同刻记录的顺序抖动（列表在不同请求间保持稳定，React key 与用户视线都不会跳）。
 */
function compareRecords(left: WorkflowRunRecord, right: WorkflowRunRecord): number {
  const byTime = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
  if (byTime !== 0) return byTime;
  const byWorkflow = (left.workflowId ?? "").localeCompare(right.workflowId ?? "");
  if (byWorkflow !== 0) return byWorkflow;
  return (left.executeId ?? "").localeCompare(right.executeId ?? "");
}

/** span 数组；`spans` 缺失或为 null 都是「本次窗口内没有运行」的合法空态。 */
function readSpans(body: unknown): unknown[] {
  const raw = readPath(body, ["spans"]);
  return Array.isArray(raw) ? raw : [];
}

/** 上游成功判定：HTTP 200 且顶层 `code === 0`（2026-10-09 起该端点是标准信封）。 */
function isSpansAccepted(result: UpstreamCallResult): boolean {
  return result.status === 200 && isRecord(result.body) && result.body.code === 0;
}

/**
 * 读平台侧运行记录（本组织的审计流水，按时间倒序）。
 *
 * **永不抛错**：它是上游清单之外的补充段落，读失败只降级成空列表 + warn 日志，绝不把对话框的主体（上游
 * 清单与错误态）拖下水。`upstreamWorkflowIds` 为空表示「本次没有任何目标」，直接返回空（不发查询）。
 */
export async function listPlatformRunRecords(
  organizationId: string,
  upstreamWorkflowIds: readonly string[],
  limit = 20,
): Promise<PlatformRunRecord[]> {
  if (upstreamWorkflowIds.length === 0) return [];
  try {
    const rows = await getWorkflowV2Database()
      .select({
        upstreamWorkflowId: workflowV2AuditLog.upstreamWorkflowId,
        result: workflowV2AuditLog.result,
        errorCode: workflowV2AuditLog.errorCode,
        createdAt: workflowV2AuditLog.createdAt,
      })
      .from(workflowV2AuditLog)
      .where(
        and(
          eq(workflowV2AuditLog.organizationId, organizationId),
          eq(workflowV2AuditLog.action, RUN_EXTERNAL_ACTION),
          inArray(workflowV2AuditLog.upstreamWorkflowId, [...upstreamWorkflowIds]),
        ),
      )
      .orderBy(desc(workflowV2AuditLog.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      upstreamWorkflowId: row.upstreamWorkflowId,
      occurredAt: row.createdAt.toISOString(),
      result: row.result,
      errorCode: row.errorCode,
    }));
  } catch (error) {
    logger.warn("workflow-v2 平台侧运行记录读取失败，仅展示上游清单", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * 读取运行记录：对每个目标取一次 `list_spans`，合并后倒序裁剪；再补一段平台侧运行记录。
 *
 * 每个目标返回的条数等于页大小即认为上游可能还有更早的运行（上游没有游标，见
 * {@link WorkflowRunRecords.hasMoreUpstream}）。
 *
 * 并发上界 = 目标数上界（路由层的常量，≤ 10），因此这里用 `Promise.all` 即可背压有界，不引入信号量；
 * 任一次调用抛出（超时/网络/会话）都会中止整批并向上抛，由路由层统一映射。
 */
export async function fetchWorkflowRunRecords(
  input: WorkflowRunRecordsInput,
  deps: { readonly callUpstream?: WorkflowRunRecordsUpstreamCall } = {},
): Promise<WorkflowRunRecordsOutcome> {
  const upstream = deps.callUpstream ?? callUpstream;
  const endAtMs = input.endAtMs ?? Date.now();
  const startAtMs = endAtMs - QUERY_WINDOW_MS;

  const results = await Promise.all(
    input.targets.map(async (target) => ({
      target,
      result: await upstream({
        path: LIST_SPANS_PATH,
        method: "POST",
        body: {
          // 请求体与上游 `ListRootSpansRequest` 逐字对应（不多送字段）：授权由上游按**工作流自身的 space** 与
          // 登录用户的关系判定，不需要平台再传 space_id。
          workflow_id: target.upstreamWorkflowId,
          start_at: startAtMs,
          end_at: endAtMs,
          limit: SPAN_PAGE_SIZE,
          desc_by_start_time: true,
        },
      }),
    })),
  );

  const failed = results.find((entry) => !isSpansAccepted(entry.result));
  if (failed) {
    logger.warn("workflow-v2 读取运行记录失败", {
      upstreamWorkflowId: failed.target.upstreamWorkflowId,
      upstreamStatus: failed.result.status,
      upstreamCode: readPath(failed.result.body, ["code"]),
    });
    return { ok: false, result: failed.result };
  }

  // 每个目标的 span 只解析一次：页满判定与合并共用同一份结果（两处各读一遍会给出两份可能不一致的事实）。
  const spansByTarget = results.map((entry) => ({ target: entry.target, spans: readSpans(entry.result.body) }));
  const merged = spansByTarget.flatMap((entry) => entry.spans.map((span) => toRunRecord(span, entry.target)));
  merged.sort(compareRecords);

  return {
    ok: true,
    records: {
      items: merged.slice(0, RUN_RECORD_LIMIT),
      truncated: merged.length > RUN_RECORD_LIMIT,
      hasMoreUpstream: spansByTarget.some((entry) => entry.spans.length === SPAN_PAGE_SIZE),
      platformRuns: await listPlatformRunRecords(
        input.organizationId,
        input.targets.map((target) => target.upstreamWorkflowId),
      ),
    },
  };
}
