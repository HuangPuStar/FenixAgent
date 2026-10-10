// pages/list/workflow-run-log-dialog.tsx
// 「运行日志」弹窗：回答「工作流最近跑过什么、结果如何」，两种入口共用这一个视图。
//
// 两种模式（同一组件、由 `workflowId` 分辨）：
// - **页面级**（`workflowId === null`）：列表页**页头**入口打开，组织内的运行记录，带工作流筛选器；上游按工作流
//   查询，因此「全部」是服务端有限扇出的合并结果，界面用 `scannedWorkflows` / `workflowTotal` 说明覆盖范围。
// - **单工作流**（`workflowId` 为本地主键）：卡片「更多」菜单打开，只查该工作流——筛选器**不渲染**（没有可筛的
//   东西，锁定成一个只有一项的下拉反而是噪音），范围提示同理不再出现（不存在覆盖偏差），标题带上工作流名。
//
// 形态是弹窗（不是抽屉，也不是独立路由，因而不动宿主 routeTree）。
//
// 数据两段（细节见服务端 `services/workflow-run-records.ts`）：
// - **运行清单**由服务端转发上游 `list_spans`（上游 2026-10-09 起为真实实现；此前曾临时只读直连上游库，已按
//   ADR `2026-10-09-workflow-v2-upstream-db-read.md` 的移除条件删除）。列表为空 = 查询窗口内确实没有运行
//   （合法空态）；读取失败走整页错误态（服务端统一映射 502/503/504），不伪装成空列表。
// - **平台侧记录**来自本地审计（平台触发的运行），永远与上游清单分开展示。
//
// 页面级模式的筛选：上游按 `workflow_id` 查询（该字段必填），因此「全部工作流」由服务端有限扇出后合并，
// 界面用 `scannedWorkflows` / `workflowTotal` 说得出这次覆盖了哪些。筛选器用原生 `<select>`：选项可能上百条，
// `ui/select` 的下拉是 portal 且不支持首字定位，原生控件在这里更合适（同款用法见 model-management 的用量面板）。
//
// 三态（§3.4）：loading → 骨架；error → `EmptyState` + 重试（`role="alert"`，文案按稳定错误码取字典键）；
// ready → 记录列表（页面级模式另有筛选器；记录为空时给空态而不是空列表）。失败**不映射成空态**——「上游读不到」
// 与「上游说没有」是两件事。重取（切换筛选、重试）只把列表区切回骨架，筛选器留在原位，且不沿用上一批行。
//
// 关闭即卸载：Radix 在关闭态不渲染 `DialogContent`，取数由此天然只在打开时发生（重新打开即重取、筛选值复位，
// 不需要手工复位状态）。

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge, type StatusTone } from "@fenix/ui-components/config/StatusBadge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { Activity, Inbox, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchRunRecords, type WorkflowV2RunWorkflowOption } from "../../api/workflow-runs";
import { WORKFLOW_NS } from "../../i18n/namespace";
import {
  formatRunTime,
  PLATFORM_RUN_RESULT_KEYS,
  RUN_STATUS_LABEL_KEYS,
  runErrorKey,
  toRunRecordRow,
  type WorkflowRunRecordRow,
} from "./workflow-run-log-model";

/** 「全部工作流」的筛选值；原生 `select` 的 value 只能是字符串，用空串表达「不筛选」。 */
const ALL_WORKFLOWS = "";

/** 弹窗尺寸：记录行是单列文本块，`sm:max-w-3xl` 容得下「名称 + 状态 + 时间 + 耗时」一行。 */
const DIALOG_CONTENT_CLASS = "sm:max-w-3xl";

/** 图标统一尺寸（不写尺寸类时 lucide 用默认 24px，与包内其它状态块不一致）。 */
const ICON_CLASS = "size-6";

/** 原生筛选控件的样式（与 model-management 的筛选行同款：主题 token + 标准 tailwind 类）。 */
const FILTER_CLASS = "h-8 rounded-md border bg-background px-2 text-sm";

/** 状态 → 色调：取值只声明语义，配色留给组件库（`StatusBadge` 的 `tone` 契约）。键取模型的键表，不写裸串。 */
const STATUS_TONES: Record<string, StatusTone> = {
  [RUN_STATUS_LABEL_KEYS.running]: "info",
  [RUN_STATUS_LABEL_KEYS.succeeded]: "success",
  [RUN_STATUS_LABEL_KEYS.failed]: "danger",
  [RUN_STATUS_LABEL_KEYS.interrupted]: "warning",
  [RUN_STATUS_LABEL_KEYS.unknown]: "neutral",
};

/**
 * 记录列表：单行一条，展示「执行 id + 模式 + 状态 + 时间 + 耗时 + 节点数 + 错误码」。
 *
 * 字段全部来自上游库的真实列（执行 id 用字符串形态、模式/状态已归一）；缺失字段已由模型定型成 null，
 * 这里只做兜底文案，不做字段缺失分支。
 */
function RunRecordList({ records }: { readonly records: readonly WorkflowRunRecordRow[] }) {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    <ul className="flex flex-col gap-2">
      {records.map((row) => (
        <li
          key={row.key}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-subtle px-3 py-2"
        >
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={row.executeId ?? undefined}>
            {t("run.record_execute_id", { id: row.executeId ?? t("run.value_unknown") })}
          </span>
          <span className="text-xs text-text-muted">{t(row.modeKey)}</span>
          <StatusBadge status={row.statusKey} label={t(row.statusKey)} tone={STATUS_TONES[row.statusKey]} />
          <span className="text-xs text-text-muted">
            {t("run.record_started_at", { time: row.startedAt ?? t("run.value_unknown") })}
          </span>
          <span className="text-xs text-text-muted">
            {t("run.record_duration", { duration: row.duration ?? t("run.value_unknown") })}
          </span>
          <span className="text-xs text-text-muted">
            {t("run.record_node_count", { count: row.nodeCount ?? t("run.value_unknown") })}
          </span>
          {row.errorCode === null ? null : (
            <span className="text-xs text-text-muted">{t("run.record_error", { code: row.errorCode })}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 筛选器：值取本地主键，选项由服务端随记录同批返回。 */
function WorkflowFilter({
  options,
  value,
  disabled,
  onChange,
}: {
  readonly options: readonly WorkflowV2RunWorkflowOption[];
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (next: string) => void;
}) {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    <div className="flex shrink-0 items-center gap-2">
      <label htmlFor="workflow-run-filter" className="text-xs text-text-muted">
        {t("run.filter_label")}
      </label>
      <select
        id="workflow-run-filter"
        className={FILTER_CLASS}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value={ALL_WORKFLOWS}>{t("run.filter_all")}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 列表区骨架：首次取数与「切换筛选后的重取」共用一份，两处的等待形态因此一致。 */
function RunLogSkeleton() {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    <div aria-busy="true" aria-label={t("run.loading")} className="flex flex-col gap-2" role="status">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

/** 弹窗正文：筛选状态与三态都在这里，标题与开合由外层持有（关闭态不渲染，因此不会后台空转）。 */
function WorkflowRunLogBody({ workflowId }: { readonly workflowId: string | null }) {
  const { t, i18n } = useTranslation(WORKFLOW_NS);
  /** 单工作流模式：查询主体由调用方给定，筛选器没有可筛的东西，因此不渲染（见文件头）。 */
  const scoped = workflowId !== null;
  const [filterId, setFilterId] = useState<string>(ALL_WORKFLOWS);
  /** 实际查询的工作流：单工作流模式恒为该目标，页面级模式由筛选器决定（空串＝全部）。 */
  const queryId = scoped ? workflowId : filterId === ALL_WORKFLOWS ? undefined : filterId;
  // `refreshDeps` 让筛选变化自动重取；`queryId` 为 undefined 时请求不带 query（服务端按「全部」扇出）。
  const runs = useRequest(() => unwrap(fetchRunRecords(queryId === undefined ? {} : { workflowId: queryId })), {
    refreshDeps: [queryId],
  });

  if (runs.error) {
    // 失败不退回空态：给重试（读取本身可恢复），文案按固定键而非服务端原文（§9.3）。
    return (
      <EmptyState
        icon={<TriangleAlert className={ICON_CLASS} />}
        title={t("run.failed_title")}
        description={t(runErrorKey(runs.error))}
        tone="danger"
        className="py-8"
        role="alert"
        action={{
          label: t("run.retry"),
          icon: <RefreshCw />,
          disabled: runs.loading,
          onClick: () => runs.refresh(),
        }}
      />
    );
  }

  const page = runs.data;
  if (page === undefined) return <RunLogSkeleton />;

  const rows = page.items.map((record, index) => toRunRecordRow(record, index, i18n.language));
  // 「全部工作流」并不等于「所有工作流」：上游按工作流查询，平台侧只扇出有限个。只在真的被截断时提示，
  // 避免一个恒显示的说明行污染每一次查看；单工作流模式下不存在这个偏差，因此不给这条提示。
  const scopeTruncated = !scoped && page.scannedWorkflows < page.workflowTotal;

  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
      {scoped ? null : (
        <WorkflowFilter options={page.workflows} value={filterId} disabled={runs.loading} onChange={setFilterId} />
      )}

      {/*
        重取期间只把**列表区**切成骨架：筛选器留在原位（否则切一次筛选控件就消失一次），而列表不沿用上一批行
        ——`useRequest` 在重取时会保留旧 `data`，照旧渲染会把上一个筛选值的记录挂在新值下面（张冠李戴比一个
        明确的加载态难查得多）。
      */}
      {runs.loading ? (
        <RunLogSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Inbox className={ICON_CLASS} />}
          title={t("run.empty_title")}
          description={t("run.empty_hint")}
          tone="neutral"
          className="py-8"
        />
      ) : (
        <>
          <RunRecordList records={rows} />
          {page.truncated ? (
            <p className="text-xs text-text-muted">{t("run.truncated_hint", { count: page.items.length })}</p>
          ) : null}
          {/*
            上游可能还有更早的运行：上游按工作流返回一页（没有游标），服务端按「页满」推断（见
            `services/workflow-run-records.ts` 的 `hasMoreUpstream`）。与 `truncated_hint`（平台侧上屏裁剪）
            互不替代，两者可以同时出现；这条约束按工作流成立，因此单工作流模式同样要给。
          */}
          {page.hasMoreUpstream ? <p className="text-xs text-text-muted">{t("run.upstream_more_hint")}</p> : null}
        </>
      )}

      {scopeTruncated ? (
        <p className="text-xs text-text-muted">
          {t("run.scope_hint", { scanned: page.scannedWorkflows, total: page.workflowTotal })}
        </p>
      ) : null}

      {/*
        平台侧运行记录：上游 2026-10-09 起有「列出执行历史」的读出口（上面的运行清单就来自它），但那只覆盖
        **上游侧**的执行；平台自己触发的运行（对外接口）在本地审计流水里另有留痕——这一段回答「平台这边跑过
        几次、结果如何」。与上游清单分开展示：两者粒度不同（时间+结果 vs 上游 span 的 logId/耗时），合并会把
        两件事说成一件。为空时不渲染整段，不给用户看一个恒空的标题。
      */}
      {page.platformRuns.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">{t("run.platform_title")}</span>
          <ul className="flex flex-col gap-1">
            {page.platformRuns.map((record) => (
              <li
                // 键取「归属 + 时刻」：同一毫秒不大可能出现同一 workflow 的两条运行记录（避免把序号当键）。
                key={`${record.upstreamWorkflowId ?? "unknown"}-${record.occurredAt}`}
                className="flex flex-col gap-1 rounded-lg border border-border-subtle px-3 py-2 text-xs"
              >
                <span className="text-text-muted">
                  {t("run.platform_time", {
                    time: formatRunTime(record.occurredAt, i18n.language) ?? t("run.value_unknown"),
                  })}
                </span>
                <span className="text-text-muted">
                  {t("run.platform_result", {
                    result: PLATFORM_RUN_RESULT_KEYS[record.result]
                      ? t(PLATFORM_RUN_RESULT_KEYS[record.result])
                      : record.result,
                  })}
                </span>
                {record.errorCode === null ? null : (
                  <span className="text-text-muted">{t("run.platform_error", { code: record.errorCode })}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted">{t("run.platform_hint")}</p>
        </section>
      )}
    </div>
  );
}

export interface WorkflowRunLogDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 单工作流模式的目标（**本地主键**）；`null` = 页面级模式（组织内的运行记录，带工作流筛选器）。 */
  readonly workflowId: string | null;
  /** 单工作流模式的展示名（标题与兜底行名）；页面级模式传空串。 */
  readonly workflowName: string;
}

export function WorkflowRunLogDialog({ open, onOpenChange, workflowId, workflowName }: WorkflowRunLogDialogProps) {
  const { t } = useTranslation(WORKFLOW_NS);
  const scoped = workflowId !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG_CONTENT_CLASS}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="size-4" />
            {scoped ? t("run.title_scoped", { name: workflowName }) : t("run.title")}
          </DialogTitle>
          <DialogDescription>{scoped ? t("run.description_scoped") : t("run.description")}</DialogDescription>
        </DialogHeader>
        <WorkflowRunLogBody workflowId={workflowId} />
      </DialogContent>
    </Dialog>
  );
}
