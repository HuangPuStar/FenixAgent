// pages/list/workflow-run-log-model.ts
// 「运行日志」视图的纯派生：错误码 → 文案键、状态 → 文案键、记录的视图模型与格式化，以及左栏（主从两栏的
// 索引列）选中项的解析。
//
// 为什么错误映射必须走稳定码：`unwrap()` 抛出的 `ApiError.message` 是后端信封原文（`UPSTREAM_*` 分支带上游
// 措辞），上屏等于把不是我方写的句子当产品文案——与列表页初始化失败同一口径
// （`workflow-list-model.ts` 的 `initializeErrorKey`）。
// 分支按「用户下一步动作不同」划分：未绑定要去列表页初始化、会话/降级要找管理员、超时与上游不可达重试即可。
//
// 返回 i18n **键**而不是文案（键是有限枚举，可被包内 i18n 用例逐个查字典）；文案取值属视图层（§9.1）。

import type { StatusTone } from "@fenix/ui-components/config/StatusBadge";
import { ApiError } from "@fenix/web-runtime/api/request";
import type { WorkflowV2PlatformRun, WorkflowV2RunRecord } from "../../api/workflow-runs";

/**
 * 控制面读取运行记录失败的「稳定错误码 → 字典键」映射。
 *
 * 其余（含请求层归一出的 `NETWORK_ERROR` / `SERVER_ERROR` 与将来新增的码）一律走通用文案——不认识的失败
 * 不该被翻译成一句看似精确的承诺。
 */
export function runErrorKey(error: unknown): string {
  const code = error instanceof ApiError ? error.code : null;
  switch (code) {
    case "UNAUTHENTICATED":
    case "UNAUTHORIZED":
    case "FORBIDDEN":
      return "run.failed_unauthorized";
    case "WORKFLOW_NOT_FOUND":
      return "run.failed_not_found";
    case "ORG_APP_NOT_BOUND":
      return "run.failed_unbound";
    case "PLATFORM_ACCOUNT_DEGRADED":
      return "run.failed_degraded";
    case "PLATFORM_ACCOUNT_NOT_PROVISIONED":
      return "run.failed_account_not_provisioned";
    case "PLATFORM_SESSION_UNAVAILABLE":
      return "run.failed_session";
    case "UPSTREAM_TIMEOUT":
      return "run.failed_timeout";
    case "UPSTREAM_UNAVAILABLE":
    case "UPSTREAM_REJECTED":
      return "run.failed_upstream";
    default:
      return "run.failed";
  }
}

/**
 * 运行状态的文案键表（含「取消」「中断」与「未知」三档；取值集与上游 `WorkflowExeStatus` 一致）。
 *
 * 由三元表达式取键时静态扫描看不到，因此导出成键表并由包内 i18n 用例枚举（与 `WORKFLOW_STATUS_HINT_KEYS`
 * 同款）：改键只有这一处，用例不会与视图漂移。
 */
export const RUN_STATUS_LABEL_KEYS = {
  running: "run.status.running",
  succeeded: "run.status.succeeded",
  failed: "run.status.failed",
  canceled: "run.status.canceled",
  interrupted: "run.status.interrupted",
  unknown: "run.status.unknown",
} as const;

/**
 * 运行模式的文案键表（含「未知」一档）：试运行 / 发布运行 / 节点调试。
 *
 * 与状态同理导出成键表：模式是上游库里的整数码，映射到用户能看懂的三档，认不出的码显示「未知」。
 */
export const RUN_MODE_LABEL_KEYS = {
  debug: "run.mode.debug",
  release: "run.mode.release",
  node_debug: "run.mode.node_debug",
  unknown: "run.mode.unknown",
} as const;

/**
 * 状态键 → 色调：取值只声明语义，配色留给组件库（`StatusBadge` 的 `tone` 契约）。键取上面的键表，不写裸串。
 *
 * 与键表同住一层是因为**左栏索引与右栏详情都要用它**（同一状态在两处必须是同一种颜色）：放在任一视图文件里
 * 都会让另一个文件反向 import 视图。只引类型（`StatusTone`）不引组件，本层仍不依赖任何 UI 实现。
 */
export const RUN_STATUS_TONES: Record<string, StatusTone> = {
  [RUN_STATUS_LABEL_KEYS.running]: "info",
  [RUN_STATUS_LABEL_KEYS.succeeded]: "success",
  [RUN_STATUS_LABEL_KEYS.failed]: "danger",
  [RUN_STATUS_LABEL_KEYS.interrupted]: "warning",
  [RUN_STATUS_LABEL_KEYS.unknown]: "neutral",
};

/** 状态 → 文案键：`null` 表示上游未给出可判读的取值（认不出的码），上屏为「未知」。 */
export function runStatusKey(status: WorkflowV2RunRecord["status"]): string {
  if (status === null) return RUN_STATUS_LABEL_KEYS.unknown;
  return RUN_STATUS_LABEL_KEYS[status];
}

/** 模式 → 文案键：`null` 表示上游未给出可判读的取值（认不出的码），上屏为「未知」。 */
export function runModeKey(mode: WorkflowV2RunRecord["mode"]): string {
  if (mode === null) return RUN_MODE_LABEL_KEYS.unknown;
  return RUN_MODE_LABEL_KEYS[mode];
}

/**
 * 某次运行的出入参数取数目标：两个标识同时存在才拿得到详情。
 *
 * - `executeId` 是**上游 execute id**（详情端点按它查询）；
 * - `upstreamWorkflowId` 是**上游 workflow ID**（详情端点按它做归属校验）——与清单筛选用的本地主键是两套
 *   标识，混用会查不到或查错，刻意分成两个字段而不是一个「id」。
 *
 * 定型在模型里而不是让组件各自判空：组件只判一次 `row.io === null`，请求参数就不用散落非空断言。
 */
export interface WorkflowRunIoTarget {
  readonly executeId: string;
  readonly upstreamWorkflowId: string;
}

/**
 * 运行记录的视图模型。
 *
 * 与协议 DTO 的分工是——DTO 里可能为 null 的字段在视图里必须已经定型成「显示什么」，组件不再做 null 分支
 * （否则每个字段的兜底会散落在 JSX 里）。
 */
export interface WorkflowRunRecordRow {
  readonly key: string;
  /** 上游 execute id（左栏以此为主标识展示，便于对照调试页与日志）；上游未给时为 null。 */
  readonly executeId: string | null;
  /**
   * 该次运行的出入参数取数目标；null 表示缺执行 ID 或缺上游 ID——缺一取不到，记录因此不可选中
   * （给一个必然失败的入口比不给更糟）。
   */
  readonly io: WorkflowRunIoTarget | null;
  /** 模式文案键（已含「未知」档）。 */
  readonly modeKey: string;
  /** 状态文案键（已含「未知」档）。 */
  readonly statusKey: string;
  /** 开始时间已格式化；null 表示上游未给时间。 */
  readonly startedAt: string | null;
  /** 耗时已格式化；null 表示上游未给耗时。 */
  readonly duration: string | null;
  /** 节点数；null 表示上游未给。 */
  readonly nodeCount: number | null;
  /** 错误码（失败运行才有）；null 表示没有或未给。 */
  readonly errorCode: string | null;
}

/**
 * 记录行的键：优先用 execute id（上游每次都回 `span_id`，正常路径稳定且唯一）；上游没给时退化为序号
 * ——React key 撞车会让记录列表渲染错位，比少一行更难发现。
 */
export function toRunRecordRow(record: WorkflowV2RunRecord, index: number, locale: string): WorkflowRunRecordRow {
  const executeId = record.executeId;
  const upstreamWorkflowId = record.workflowId;
  return {
    key: executeId ?? `run-${index}`,
    executeId,
    io: executeId !== null && upstreamWorkflowId !== null ? { executeId, upstreamWorkflowId } : null,
    modeKey: runModeKey(record.mode),
    statusKey: runStatusKey(record.status),
    startedAt: formatRunTime(record.createdAt, locale),
    duration: formatRunDuration(record.durationMs),
    nodeCount: record.nodeCount,
    errorCode: record.errorCode,
  };
}

/**
 * 平台侧运行记录的视图模型：左栏底部分组的条目，同时是右栏「没有输入输出」说明的载体。
 *
 * 平台记录没有 execute id（它只有平台自己的调用流水），因此**永远不会混进执行记录列表**，也就永远进不了
 * 详情取数；右栏对它只展示已有字段，并明确说明输入输出不存在（不留一块白板）。
 */
export interface WorkflowPlatformRunRow {
  /** 左栏选中键（与执行记录的键共处一个选中空间，见 `runSelectionKey`）。 */
  readonly key: string;
  /** 时间已格式化；null 表示时间串不可解析（上游写坏值）。 */
  readonly time: string | null;
  /** 归一化结果原样带上（`ok` / `upstream_rejected` …），认不出的取值由视图如实展示。 */
  readonly result: string;
  readonly errorCode: string | null;
}

export function toPlatformRunRow(record: WorkflowV2PlatformRun, locale: string): WorkflowPlatformRunRow {
  return {
    // 键取「归属 + 时刻」：同一毫秒不大可能出现同一 workflow 的两条运行记录（避免把序号当键）。
    key: `platform:${record.upstreamWorkflowId ?? "unknown"}-${record.occurredAt}`,
    time: formatRunTime(record.occurredAt, locale),
    result: record.result,
    errorCode: record.errorCode,
  };
}

/**
 * 执行记录在左栏的选中键：与平台记录的键共处一个选中空间，因此带前缀——两侧键撞车会让右栏显示另一次运行
 * 的出入参数。只有可选中（`io !== null`）的记录才会被算进这个空间。
 */
export function runSelectionKey(row: WorkflowRunRecordRow): string {
  return `run:${row.key}`;
}

/** 左栏当前选中项：`key` 用于与条目比较选中态，`run` / `platform` 是解析出的实体（至多一个非空）。 */
export interface WorkflowRunSelection {
  readonly key: string | null;
  readonly run: WorkflowRunRecordRow | null;
  readonly platform: WorkflowPlatformRunRow | null;
}

/**
 * 解析左栏选中项：打开即选中第一条可查看详情的执行记录；选中键在**当前这一批**里不存在时（切换筛选换了
 * 一批、或该记录本批已消失）同样回落——右栏不会显示一条已经不在列表里的运行。
 *
 * 回落顺序是「第一条执行记录 → 第一条平台记录 → 无」：执行记录是主内容，平台记录是底部分组的补充。
 * 两者都没有可选中项时返回空选中，右栏据此说明「缺执行 ID，看不到输入输出」而不是留白。
 *
 * 为什么是纯派生而不是用 effect 同步：`selectedKey` 只是用户的**意图**，能不能用由当前批次决定；派生渲染
 * 天然不会出现「状态与列表不一致」的那一帧，切换筛选也不必额外跑一次状态修正。
 */
export function resolveRunSelection(
  rows: readonly WorkflowRunRecordRow[],
  platformRows: readonly WorkflowPlatformRunRow[],
  selectedKey: string | null,
): WorkflowRunSelection {
  const selectable = rows.filter((row) => row.io !== null);
  const firstSelectable = selectable.length > 0 ? selectable[0] : undefined;
  const firstPlatform = platformRows.length > 0 ? platformRows[0] : undefined;
  const fallbackKey = firstSelectable ? runSelectionKey(firstSelectable) : (firstPlatform?.key ?? null);
  const known =
    selectedKey !== null &&
    (selectable.some((row) => runSelectionKey(row) === selectedKey) ||
      platformRows.some((row) => row.key === selectedKey));
  const key = known ? selectedKey : fallbackKey;

  return {
    key,
    run: selectable.find((row) => runSelectionKey(row) === key) ?? null,
    platform: platformRows.find((row) => row.key === key) ?? null,
  };
}

/** 时间上屏格式：跟随当前 locale（不得在共享模块里固定 `zh-CN`，§9.3）；无效时间串回落为 null。 */
/**
 * 平台侧运行结果 → 字典键；认不出的结果由调用方回落成原始串（如实展示，不翻译成看似精确的结论）。
 *
 * 与 `runErrorKey` 的分工：那个映射的是**本次读取失败**（HTTP 层），这里映射的是**每次运行的结果标签**。
 */
export const PLATFORM_RUN_RESULT_KEYS: Record<string, string> = {
  ok: "run.result.ok",
  upstream_rejected: "run.result.upstream_rejected",
  upstream_unavailable: "run.result.upstream_unavailable",
  failed: "run.result.failed",
};

export function formatRunTime(iso: string | null, locale: string): string | null {
  if (iso === null) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString(locale);
}

/**
 * 耗时上屏格式：毫秒与秒两档（单位是 SI 符号，不进字典）。
 *
 * 秒以下保留整毫秒、秒以上保留一位小数：运行日志关心的是量级而不是精度，`1234 ms` 与 `1.2 s` 对排查同样
 * 有用，但一串 `1234.567 ms` 只会挤掉同一行里的状态与时间。
 */
export function formatRunDuration(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

/**
 * 出入参数上屏：JSON 字符串按两空格缩进重新序列化；解析失败保持原文。
 *
 * 上游回的是 JSON 序列化字符串，但形态不受我方能控（可能是纯文本或上游自己的截断形态）——原样兜底比
 * 报错或隐藏更能说明现状。
 */
export function formatRunIoValue(value: string | null): string | null {
  if (value === null) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
