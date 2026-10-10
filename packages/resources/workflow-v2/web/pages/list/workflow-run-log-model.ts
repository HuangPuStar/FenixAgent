// pages/list/workflow-run-log-model.ts
// 「运行日志」视图的纯派生：错误码 → 文案键、状态 → 文案键、记录的视图模型与格式化。
//
// 为什么错误映射必须走稳定码：`unwrap()` 抛出的 `ApiError.message` 是后端信封原文（`UPSTREAM_*` 分支带上游
// 措辞），上屏等于把不是我方写的句子当产品文案——与列表页初始化失败同一口径
// （`workflow-list-model.ts` 的 `initializeErrorKey`）。
// 分支按「用户下一步动作不同」划分：未绑定要去列表页初始化、会话/降级要找管理员、超时与上游不可达重试即可。
//
// 返回 i18n **键**而不是文案（键是有限枚举，可被包内 i18n 用例逐个查字典）；文案取值属视图层（§9.1）。

import { ApiError } from "@fenix/web-runtime/api/request";
import type { WorkflowV2RunRecord } from "../../api/workflow-runs";

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
 * 运行记录的视图模型。
 *
 * 与协议 DTO 的分工是——DTO 里可能为 null 的字段在视图里必须已经定型成「显示什么」，组件不再做 null 分支
 * （否则每个字段的兜底会散落在 JSX 里）。
 */
export interface WorkflowRunRecordRow {
  readonly key: string;
  /** 上游 execute id（行内展示完整 id，便于对照调试页与日志）；上游未给时为 null。 */
  readonly executeId: string | null;
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
  return {
    key: record.executeId ?? `run-${index}`,
    executeId: record.executeId,
    modeKey: runModeKey(record.mode),
    statusKey: runStatusKey(record.status),
    startedAt: formatRunTime(record.createdAt, locale),
    duration: formatRunDuration(record.durationMs),
    nodeCount: record.nodeCount,
    errorCode: record.errorCode,
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
