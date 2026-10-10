// pages/list/workflow-run-log-detail.tsx
// 「运行日志」弹窗的右栏：选中的那一条运行的详情（执行记录 = 元信息 + 输入 / 输出；平台记录 = 已有字段 + 说明）。
//
// 为什么单独成文件：这一层的请求状态只属于**当前选中的那一条**，与左栏索引是两件事。调用方按选中键 `key`
// 重挂载（`key={row.key}`），切换选中即换掉整份请求状态——不需要手写清理，也不会出现「新的选中项配上一批
// 数据」的那一帧（`useRequest` 在重取期间会保留旧 `data`）。
//
// 取数口径（设计见 `docs/design/2026-10-10-workflow-v2-run-io.md` §1）：出入参数**不在清单接口里**，只能按
// execute id 单独取一次；一次弹窗因此最多两条上游请求（清单 + 当前选中项），不随记录条数增长。
//
// 三态（§3.4）：在途 → 骨架 + 加载文案；失败 → `EmptyState` + 重试（`role="alert"`，文案按稳定错误码取字典
// 键，不回显服务端原文）；就绪 → 输入 / 输出两块。空值（上游未提供）**不是**失败，也不与失败共用呈现。
//
// 平台侧记录没有输入输出可看（它只有平台自己的调用流水）：右栏对它展示已有字段并**显式说明**这一点，
// 不留白板，也不摆两个空块——那会被读成「上游这次没给」。

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { Info, RefreshCw, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchRunIo } from "../../api/workflow-runs";
import { WORKFLOW_NS } from "../../i18n/namespace";
import {
  formatRunIoValue,
  PLATFORM_RUN_RESULT_KEYS,
  RUN_STATUS_TONES,
  runErrorKey,
  type WorkflowPlatformRunRow,
  type WorkflowRunIoTarget,
  type WorkflowRunRecordRow,
} from "./workflow-run-log-model";

/** 图标统一尺寸（不写尺寸类时 lucide 用默认 24px，与包内其它状态块不一致）。 */
const ICON_CLASS = "size-6";

/**
 * 选中记录的头部：执行 ID 完整上屏（左栏窄列会截断）+ 模式 / 状态 / 时间 / 耗时 / 节点数 / 错误码。
 *
 * 这些字段在左栏也有一份（索引要能扫），这里是**可直接读到全文**的那一份：节点数与错误码只在详情出现
 * ——窄列塞不下，而它们是「这次为什么失败」的入口。
 */
function RunDetailHeader({ row }: { readonly row: WorkflowRunRecordRow }) {
  const { t } = useTranslation(WORKFLOW_NS);
  const unknown = t("run.value_unknown");

  return (
    <div className="flex flex-col gap-2 border-b border-border-subtle pb-3">
      <span className="text-sm font-medium break-all">
        {t("run.record_execute_id", { id: row.executeId ?? unknown })}
      </span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <StatusBadge status={row.statusKey} label={t(row.statusKey)} tone={RUN_STATUS_TONES[row.statusKey]} />
        <span>{t(row.modeKey)}</span>
        <span>{t("run.record_started_at", { time: row.startedAt ?? unknown })}</span>
        <span>{t("run.record_duration", { duration: row.duration ?? unknown })}</span>
        <span>{t("run.record_node_count", { count: row.nodeCount ?? unknown })}</span>
        {row.errorCode === null ? null : <span>{t("run.record_error", { code: row.errorCode })}</span>}
      </div>
    </div>
  );
}

/** 出入参数的一块：标题 + 等宽预格式文本；值为 null 时给「上游未提供」。 */
function RunIoBlock({ label, value }: { readonly label: string; readonly value: string | null }) {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text-muted">{label}</span>
      {value === null ? (
        <span className="text-xs text-text-muted">{t("run.value_unknown")}</span>
      ) : (
        // 不再给单块限高：右栏本身是滚动边界，两块各自再套一层滚动会让「读一段长输出」变成两段滚动的接力。
        <pre className="overflow-x-auto rounded-md border border-border-subtle bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap break-all">
          {value}
        </pre>
      )}
    </div>
  );
}

/** 出入参数骨架：在途时给两块占位，避免把「还没读到」显示成「上游未提供」。 */
function RunIoSkeleton() {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    <div className="flex flex-col gap-3" role="status">
      <p className="text-xs text-text-muted">{t("run.io_loading")}</p>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

/**
 * 执行记录的详情：元信息 + 该次运行的输入参数与输出结果。
 *
 * `target` 由调用方从 `row.io` 收窄后传入（两个标识都非空，见 `WorkflowRunRecordRow.io`），因此这里不再判空。
 */
export function RunIoDetail({
  row,
  target,
}: {
  readonly row: WorkflowRunRecordRow;
  readonly target: WorkflowRunIoTarget;
}) {
  const { t } = useTranslation(WORKFLOW_NS);
  const io = useRequest(() =>
    unwrap(fetchRunIo({ upstreamWorkflowId: target.upstreamWorkflowId, executeId: target.executeId })),
  );

  return (
    <div className="flex flex-col gap-4">
      <RunDetailHeader row={row} />
      {io.error ? (
        // 详情失败**不升级**成整页错误：列表照常可用，用户能换一条记录看；重试只重取这一条。
        <EmptyState
          icon={<TriangleAlert className={ICON_CLASS} />}
          title={t("run.io_failed_title")}
          description={t(runErrorKey(io.error))}
          tone="danger"
          className="py-6"
          role="alert"
          action={{
            label: t("run.retry"),
            icon: <RefreshCw />,
            disabled: io.loading,
            onClick: () => io.refresh(),
          }}
        />
      ) : io.data === undefined ? (
        <RunIoSkeleton />
      ) : (
        <>
          <RunIoBlock label={t("run.io_input")} value={formatRunIoValue(io.data.input)} />
          <RunIoBlock label={t("run.io_output")} value={formatRunIoValue(io.data.output)} />
        </>
      )}
    </div>
  );
}

/**
 * 平台侧运行记录的详情：只有平台自己的字段（时间 / 结果 / 错误码）。
 *
 * 输入输出**不存在**于这一侧（平台只留调用流水），因此不给两个空块而是给一句明确说明——「没有数据」与
 * 「这次运行确实没有输入输出」在界面上必须分得开。
 */
export function PlatformRunDetail({ row }: { readonly row: WorkflowPlatformRunRow }) {
  const { t } = useTranslation(WORKFLOW_NS);
  const resultKey = PLATFORM_RUN_RESULT_KEYS[row.result];

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex flex-col gap-1 text-text-muted">
        <span>{t("run.platform_time", { time: row.time ?? t("run.value_unknown") })}</span>
        {/* 认不出的结果如实展示原文（与列表同口径，不翻译成看似精确的结论）。 */}
        <span>{t("run.platform_result", { result: resultKey ? t(resultKey) : row.result })}</span>
        {row.errorCode === null ? null : <span>{t("run.platform_error", { code: row.errorCode })}</span>}
      </div>
      <div className="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-2 p-3 text-text-muted">
        <Info className="size-4 shrink-0" aria-hidden="true" />
        <span>{t("run.platform_no_io")}</span>
      </div>
    </div>
  );
}
