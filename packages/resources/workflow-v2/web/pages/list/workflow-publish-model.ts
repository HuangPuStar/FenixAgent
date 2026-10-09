// pages/list/workflow-publish-model.ts
// 列表页**发布动作与日志弹窗**的纯派生：错误码 → 文案键、本地登记版本与上游发布版本的漂移判定、日志记录的
// 视图模型，以及控制台发布请求的固定策略。
//
// 为什么错误映射必须走稳定码：`unwrap()` 抛出的 `ApiError.message` 是后端信封原文（`UPSTREAM_*` 分支带上游
// 措辞、`INTERNAL_ERROR` 带服务端内部描述），上屏等于把不是我方写的句子当产品文案——与列表页初始化失败同一
// 口径（`workflow-list-model.ts` 的 `initializeErrorKey`）。四个「下一步动作不同」的类别必须分开：草稿未验证
// 要先去画布跑一次、版本未自增要先对账、会话失效要重新登录、上游不可达稍后重试即可。
//
// 返回 i18n **键**而不是文案（键是有限枚举，可被包内 i18n 用例逐个查字典）；文案取值属视图层（§9.1）。

import { ApiError } from "@fenix/web-runtime/api/request";

/**
 * 控制台发布固定携带 `force: true`。
 *
 * 依据是**一致性与可达性**，不是图省事：上游画布内的发布按钮自己就是 `force: true`
 * （上游 `playground/src/services/workflow-operation-service.ts` 的 `PublishWorkflow` 调用），若控制台不发
 * `force`，同一个 workflow 会出现「画布里点得动、控制台报『草稿未通过调试运行』」的分裂行为——而列表页
 * 用户看不到画布草稿状态，也没有第二个入口去补一次 `test_run`。
 */
export const CONSOLE_PUBLISH_FORCE = true;

/**
 * 控制面发布失败的「稳定错误码 → 字典键」映射。
 *
 * 分支对应**用户下一步动作不同**的几类：草稿未验证要去画布跑一次、版本未自增要先对账、版本号非法说明本地
 * 记录坏了、未绑定/降级要回列表页初始化或找管理员、会话失效要重新登录、上游不可达稍后重试；其余（含请求层
 * 归一出的 `NETWORK_ERROR` / `SERVER_ERROR` 与将来新增的码）一律走通用文案——不认识的失败不该被翻译成一句
 * 看似精确的承诺。
 */
export function publishErrorKey(error: unknown): string {
  const code = error instanceof ApiError ? error.code : null;
  switch (code) {
    case "UNAUTHENTICATED":
    case "UNAUTHORIZED":
    case "FORBIDDEN":
      return "publish.failed_unauthorized";
    case "WORKFLOW_NOT_FOUND":
      return "publish.failed_not_found";
    case "ORG_APP_NOT_BOUND":
      return "publish.failed_unbound";
    case "PLATFORM_ACCOUNT_DEGRADED":
      return "publish.failed_degraded";
    case "PLATFORM_SESSION_UNAVAILABLE":
      return "publish.failed_session";
    case "WORKFLOW_DRAFT_NOT_VERIFIED":
      return "publish.failed_draft_not_verified";
    case "WORKFLOW_VERSION_NOT_INCREMENTAL":
      return "publish.failed_version_not_incremental";
    case "WORKFLOW_VERSION_INVALID":
    case "WORKFLOW_VERSION_UNPARSEABLE":
      return "publish.failed_version_invalid";
    case "UPSTREAM_TIMEOUT":
      return "publish.failed_timeout";
    case "UPSTREAM_UNAVAILABLE":
    case "UPSTREAM_REJECTED":
      return "publish.failed_upstream";
    default:
      return "publish.failed";
  }
}

/**
 * 发布按钮的两态文案键（列表行操作与宿主页工具栏共用同一对）。
 *
 * 两态由三元表达式取键，静态扫描看不到，因此导出成键表并由包内 i18n 用例枚举（与 `UPDATED_AT_KEYS` 同款）：
 * 改键只有这一处，用例不会与页面漂移。
 */
export const PUBLISH_ACTION_LABEL_KEYS = {
  idle: "publish.action",
  busy: "publish.action_publishing",
} as const;

/**
 * 本地登记版本与上游当前发布版本的比对结论。
 *
 * `drift` 是本次改动**明确要暴露**的状态：画布内经 BFF 的发布不写回本地注册表（已知缺口，见
 * `src/server/services/workflow-publish.ts` 文件头），此时本地版本落后于上游，下一次控制台发布会撞上「版本
 * 未自增」。对话框把上游版本与本地版本并排给出，就是让用户先看到这个偏差，而不是等发布被拒。
 */
export type WorkflowPublishDrift =
  /** 两侧都没有发布版本：一致，且都是「未发布」。 */
  | { readonly kind: "unpublished" }
  | { readonly kind: "match"; readonly version: string }
  | { readonly kind: "drift"; readonly local: string | null; readonly upstream: string | null };

export function resolvePublishDrift(local: string | null, upstream: string | null): WorkflowPublishDrift {
  if (local === null && upstream === null) return { kind: "unpublished" };
  if (local !== null && local === upstream) return { kind: "match", version: local };
  return { kind: "drift", local, upstream };
}

/**
 * 日志（上游发布记录）的视图模型。
 *
 * 与协议 DTO 的分工是——DTO 里可能为 null 的字段在视图里必须已经定型成「显示什么」，组件不再做 null 分支
 * （否则每个字段的兜底会散落在 JSX 里）。
 */
export interface WorkflowPublishRecordRow {
  readonly key: string;
  /** 记录名；上游没给名字时由调用方传入的兜底文案（当前 workflow 的名称）顶上。 */
  readonly name: string;
  /** 发布时间已格式化；`null` 表示上游未给时间。 */
  readonly publishedAt: string | null;
  readonly ownerId: string | null;
}

/** 记录行的键：上游 ID 缺失时用序号兜底（记录可能既无 id 也无时间，必须保证 React key 唯一且稳定）。 */
export function toPublishRecordRow(
  record: {
    readonly workflowId: string | null;
    readonly name: string | null;
    readonly publishedAt: string | null;
    readonly ownerId: string | null;
  },
  index: number,
  fallbackName: string,
): WorkflowPublishRecordRow {
  return {
    key: record.workflowId ?? `record-${index}`,
    name: record.name ?? fallbackName,
    publishedAt: record.publishedAt,
    ownerId: record.ownerId,
  };
}

/** 发布时间上屏格式：跟随当前 locale（不得在共享组件里固定 `zh-CN`，§9.3）；无效时间串回落为 null。 */
export function formatPublishTime(iso: string | null, locale: string): string | null {
  if (iso === null) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString(locale);
}
