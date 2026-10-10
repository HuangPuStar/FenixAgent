// pages/list/workflow-run-log-dialog.tsx
// 「运行日志」弹窗：回答「工作流最近跑过什么、结果如何」，两种入口共用这一个视图。
//
// 形态是**主从两栏**：左窄栏按执行 ID 列出运行记录（平台触发的运行在底部分组），右宽栏展示选中项的输入与
// 输出。不做行内展开——记录一条只有执行 ID 可辨识，逐行展开会把每条撑成两段 JSON，列表最终读不出「跑过几次、
// 哪次失败」。窄屏（`md` 以下）降级为上下单列。
//
// **外框高度固定**（`h-[90vh]`），两栏在固定高度内各自滚动：弹窗是垂直居中的，内容一变（骨架 ↔ 内容、不同
// 记录的不同长度输出、失败态）外框就换高，整块会跟着重新居中——点一下记录「抖一下」的来源就在这里。固定外框
// 之后，高度链是 `DialogContent(h-[90vh]) → 正文(flex-1 min-h-0) → 两栏(flex-1 min-h-0) → 两列(min-h-0 +
// overflow-y-auto)`，页面级的滚动条不会再出现第二条。
//
// 取数期间（首帧与切换筛选的重取）两栏**不重建**：左栏容器留在原位、只把记录区换成骨架——否则窄列会先闪成
// 空的、再被回填的行撑开，滚动位置也跟着跳回顶部。右栏容器按选中键重建（见 `RunLogPane`），切换记录即从顶部
// 开始读。
//
// 两种模式（同一组件、由 `workflowId` 分辨）：
// - **页面级**（`workflowId === null`）：列表页**页头**入口打开，组织内的运行记录，带工作流筛选器；上游按工作流
//   查询，因此「全部」是服务端有限扇出的合并结果，界面用 `scannedWorkflows` / `workflowTotal` 说明覆盖范围。
// - **单工作流**（`workflowId` 为本地主键）：卡片「更多」菜单打开，只查该工作流——筛选器**不渲染**（没有可筛的
//   东西，锁定成一个只有一项的下拉反而是噪音），范围提示同理不再出现（不存在覆盖偏差），标题带上工作流名。
//
// 数据两段（细节见服务端 `services/workflow-run-records.ts`）：
// - **运行清单**由服务端转发上游 `list_spans`（上游 2026-10-09 起为真实实现；此前曾临时只读直连上游库，已按
//   ADR `2026-10-09-workflow-v2-upstream-db-read.md` 的移除条件删除）。列表为空 = 查询窗口内确实没有运行
//   （合法空态）；读取失败走整页错误态（服务端统一映射 502/503/504），不伪装成空列表。
// - **平台侧记录**来自本地审计（平台触发的运行），永远与上游清单分开展示，落在左栏底部的独立分组。
//
// 页面级模式的筛选：上游按 `workflow_id` 查询（该字段必填），因此「全部工作流」由服务端有限扇出后合并，
// 界面用 `scannedWorkflows` / `workflowTotal` 说得出这次覆盖了哪些。筛选器用原生 `<select>`：选项可能上百条，
// `ui/select` 的下拉是 portal 且不支持首字定位，原生控件在这里更合适（同款用法见 model-management 的用量面板）。
//
// 三态（§3.4）：loading → 骨架；error → `EmptyState` + 重试（`role="alert"`，文案按稳定错误码取字典键）；
// ready → 两栏。记录为空时左栏给空态而不是空列表；失败**不映射成空态**——「上游读不到」与「上游说没有」是
// 两件事。重取（切换筛选、重试）只把两栏区切回骨架，筛选器留在原位，且不沿用上一批行。
// 三条范围提示（平台侧裁剪 / 上游页满 / 扇出未覆盖全部工作流）落在两栏下方的固定提示条：左栏是窄列，
// 提示塞进去只会被截断或淹没在滚动里。
//
// 选中项的请求状态在右栏组件内（`workflow-run-log-detail.tsx`）：按选中键 `key` 重挂载，切换记录即换掉整份
// 状态。打开即自动选中第一条**可查看详情**的记录——空态等待会让用户以为这里没东西可看。左栏索引连同它的选中
// 态与滚动边界在同目录 `workflow-run-log-index.tsx`，本文件只管外壳：取数三态、筛选器、两栏布局与范围提示。
//
// 关闭即卸载：Radix 在关闭态不渲染 `DialogContent`，取数由此天然只在打开时发生（重新打开即重取、筛选值复位，
// 不需要手工复位状态）。

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { Activity, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchRunRecords, type WorkflowV2RunLogPage, type WorkflowV2RunWorkflowOption } from "../../api/workflow-runs";
import { WORKFLOW_NS } from "../../i18n/namespace";
import { PlatformRunDetail, RunIoDetail } from "./workflow-run-log-detail";
import { RunIndex } from "./workflow-run-log-index";
import { resolveRunSelection, runErrorKey, toPlatformRunRow, toRunRecordRow } from "./workflow-run-log-model";

/** 「全部工作流」的筛选值；原生 `select` 的 value 只能是字符串，用空串表达「不筛选」。 */
const ALL_WORKFLOWS = "";

/** 图标统一尺寸（不写尺寸类时 lucide 用默认 24px，与包内其它状态块不一致）。 */
const ICON_CLASS = "size-6";

/** 原生筛选控件的样式（与 model-management 的筛选行同款：主题 token + 标准 tailwind 类）。 */
const FILTER_CLASS = "h-8 rounded-md border bg-background px-2 text-sm";

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

/** 右栏骨架：重取期间顶住详情区（不上屏上一批记录的出入参数——张冠李戴比骨架难查）。 */
function RunDetailSkeleton() {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    <div aria-label={t("run.loading")} className="flex flex-col gap-3" role="status">
      <Skeleton className="h-5 w-56" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/**
 * 两栏区：左栏索引 + 右栏详情。
 *
 * 选中项由**当前这一批**派生（`resolveRunSelection`），因此这里只存用户点过的键：切换筛选换了批次后，键比对
 * 让选中自动回落到新一批的第一条，不需要在渲染之外再同步一次状态。
 *
 * `loading` 为真时（首帧与切换筛选的重取）两栏都不上屏数据：`useRequest` 重取时保留旧 `data`，照旧渲染会把
 * 上一个筛选值的记录挂在新值下面（张冠李戴比一个明确的骨架难查）。但**容器不重建**：左栏的滚动边界因此不在
 * 取数时跳回顶部，外框高度也不随内容变化。
 */
function RunLogPane({
  page,
  loading,
  locale,
}: {
  readonly page: WorkflowV2RunLogPage | undefined;
  readonly loading: boolean;
  readonly locale: string;
}) {
  const { t } = useTranslation(WORKFLOW_NS);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const rows =
    loading || page === undefined ? [] : page.items.map((record, index) => toRunRecordRow(record, index, locale));
  const platformRows =
    loading || page === undefined ? [] : page.platformRuns.map((record) => toPlatformRunRow(record, locale));
  const selection = resolveRunSelection(rows, platformRows, selectedKey);
  const selectedRun = selection.run;
  // 先收起再判空：`selectedRun.io` 的类型收窄在 JSX 里跟着两条条件走，容易在改动时静默失效。
  const selectedTarget = selectedRun?.io ?? null;

  return (
    // 窄屏单列（左栏限高 `max-h-64` 并自行滚动）、`md` 起两栏：左栏固定 `w-60`（15rem，与主从壳的索引列同尺），
    // 右栏吃掉剩余宽度。不写 `grid-cols-[...]` 是门禁（FCP-WEB-02）与既有先例的共同口径——固定/弹性分工用
    // `md:w-60 md:flex-none` + `min-w-0 flex-1` 表达，不需要任意值列模板；窄屏的限高用固定刻度而不是百分比：
    // 百分比要一个确定高度作基准，刻度没有这个前提。
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <RunIndex
        rows={rows}
        platformRows={platformRows}
        selection={selection}
        loading={loading}
        onSelect={setSelectedKey}
      />
      {/*
        右栏按选中键重建（`key`）：新选中项的详情从顶部开始读，上一条的滚动位置不会跟过来；`RunIoDetail` 的
        取数状态也随之整份换掉（detail 文件头）。happy-dom 不做真实布局、`scrollTop` 不可信，这条机制由用例按
        节点身份钉住。
        `[scrollbar-gutter:stable]`：不同记录的输出长度差别很大，滚动条一出现一消失会把内容宽度挤来挤去
        （`pre` 是 `break-all`，重排到每一行）——预留槽位后宽度恒定，点记录时右栏不会横向抖。
      */}
      <div
        key={selection.key ?? "none"}
        data-slot="run-detail-scroll"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3 [scrollbar-gutter:stable]"
      >
        {loading ? (
          <RunDetailSkeleton />
        ) : selectedRun !== null && selectedTarget !== null ? (
          <RunIoDetail row={selectedRun} target={selectedTarget} />
        ) : selection.platform !== null ? (
          <PlatformRunDetail row={selection.platform} />
        ) : (
          // 一条都选不中（记录缺执行 ID 或上游 ID）：说明为什么没有详情，不留白板。
          <p className="text-xs text-text-muted">{t("run.detail_unavailable")}</p>
        )}
      </div>
    </div>
  );
}

/**
 * 三条范围提示的固定条（左栏是窄列，塞进滚动区会被截断或淹没）。
 *
 * 三者互不替代，可以同时出现：
 * - 平台侧上屏裁剪（`truncated`）：说得出「只有 50 条」而不是「一共 50 次运行」；
 * - 上游按工作流的返回上限（`hasMoreUpstream`，没有游标，服务端按「页满」推断）：可能与上一条同时成立；
 * - 扇出未覆盖全部工作流（`scopeTruncated`）：页面级模式独有，按工作流成立的偏差。
 *
 * 取数期间不渲染：它们描述的是上一批的覆盖范围，显示出来就是一句过期的结论。
 */
function RunLogNotices({
  page,
  scopeTruncated,
}: {
  readonly page: WorkflowV2RunLogPage;
  readonly scopeTruncated: boolean;
}) {
  const { t } = useTranslation(WORKFLOW_NS);

  if (!page.truncated && !page.hasMoreUpstream && !scopeTruncated) return null;

  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-border-subtle px-6 py-2">
      {page.truncated ? (
        <p className="text-xs text-text-muted">{t("run.truncated_hint", { count: page.items.length })}</p>
      ) : null}
      {page.hasMoreUpstream ? <p className="text-xs text-text-muted">{t("run.upstream_more_hint")}</p> : null}
      {scopeTruncated ? (
        <p className="text-xs text-text-muted">
          {t("run.scope_hint", { scanned: page.scannedWorkflows, total: page.workflowTotal })}
        </p>
      ) : null}
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
    // 失败不退回空态：给重试（读取本身可恢复），文案按固定键而非服务端原文（§9.3）。错误态在固定外框里居中，
    // 否则外框下半屏会留一大块空白，看起来像内容被截断。
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
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
      </div>
    );
  }

  const page = runs.data;
  const loading = runs.loading || page === undefined;
  // 筛选器的选项与记录同批返回：还没数据时无选项可给（取数期间筛选器留在原位，否则切一次筛选控件就消失一次）。
  const showFilter = !scoped && page !== undefined;
  // 「全部工作流」并不等于「所有工作流」：上游按工作流查询，平台侧只扇出有限个。只在真的被截断时提示，
  // 避免一个恒显示的说明行污染每一次查看；单工作流模式下不存在这个偏差，因此不给这条提示。
  const scopeTruncated = !scoped && page !== undefined && page.scannedWorkflows < page.workflowTotal;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showFilter ? (
        <div className="flex shrink-0 items-center border-b border-border-subtle px-6 py-2">
          <WorkflowFilter options={page.workflows} value={filterId} disabled={runs.loading} onChange={setFilterId} />
        </div>
      ) : null}

      {/* 两栏在取数期间也在位（只把内部内容换成骨架），外框与两个滚动边界因此不随状态重建。 */}
      <RunLogPane page={page} loading={loading} locale={i18n.language} />

      {loading || page === undefined ? null : <RunLogNotices page={page} scopeTruncated={scopeTruncated} />}
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
      {/*
        `size="xl"`：960px 宽、`overflow-hidden flex flex-col`（两栏的 `min-h-0` 与各自 `overflow-y-auto` 靠
        它成立）。`h-[90vh]` 与变体自带的 `max-h-[90vh]` 合起来是**固定高度**：弹窗垂直居中，外框一旦跟着内容
        换高，切一次记录整块就会重新居中（「点一下抖一下」的来源）。页头与筛选器 `shrink-0` 留在原位，只有两栏
        滚动。
      */}
      <DialogContent size="xl" className="h-[90vh]">
        <DialogHeader className="shrink-0 border-b border-border-subtle px-6 py-4 pr-12">
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
