// pages/list/workflow-log-dialog.tsx
// 「日志」弹窗：列表行操作「日志」打开的独立弹窗，回答「这个 workflow 发布过什么、上游现在认的版本是哪个」。
//
// 数据**全部来自上游**（服务端转发 `list_publish_workflow` 与 canvas 的 `workflow_version`），本组件与平台侧都
// 不落发布日志：`records` 为空就是上游没有记录（合法空态，见 `src/server/services/workflow-publish-records.ts`
// 文件头的缺口说明），不拿本地 `publishedVersion` 伪造一条记录。
//
// 三态（§3.4）：loading → 骨架；error → `EmptyState` + 重试（`role="alert"`）；ready → 上游版本对照 + 记录列表
// （记录为空时给空态而不是空列表）。失败**不映射成空态**——「上游读不到」与「上游说没有」是两件事。
//
// 关闭即卸载：Radix 在关闭态不渲染 `DialogContent`，取数由此天然只在打开时发生（重新打开即重取，不需要手工
// 复位状态）；`workflowId` 为 null（列表尚未给出目标）时正文不挂载，避免拿空身份发请求。

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { History, Inbox, RefreshCw, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchPublishOverview } from "../../api/workflow-publish";
import { WORKFLOW_NS } from "../../i18n/namespace";
import { formatPublishTime, resolvePublishDrift, toPublishRecordRow } from "./workflow-publish-model";

export interface WorkflowLogDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 本地主键；null 表示目标未确定，此时不取数。 */
  readonly workflowId: string | null;
  /** 记录名缺失时的兜底展示名（当前 workflow 的名称）。 */
  readonly workflowName: string;
  /** 控制台已知的本地登记版本；与上游版本比对漂移（`resolvePublishDrift`）。 */
  readonly localPublishedVersion: string | null;
}

/** 弹窗尺寸：记录列表是单列文本块，`sm:max-w-2xl` 与同类查看弹窗一致。 */
const DIALOG_CONTENT_CLASS = "sm:max-w-2xl";

/** 图标统一尺寸（不写尺寸类时 lucide 用默认 24px，与包内其它状态块不一致）。 */
const ICON_CLASS = "size-6";

/** 上游版本对照的一行：标签 + 值（值缺失时显示统一的「未发布」文案，不显示 null）。 */
function VersionRow({
  label,
  version,
  none,
}: {
  readonly label: string;
  readonly version: string | null;
  readonly none: string;
}) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-text-muted">{label}</span>
      <span className="font-medium">{version ?? none}</span>
    </div>
  );
}

/** 弹窗正文：取数与三态都在这里，标题与开合由外层持有（关闭态不渲染，因此不会后台空转）。 */
function WorkflowLogBody({
  workflowId,
  workflowName,
  localPublishedVersion,
}: {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly localPublishedVersion: string | null;
}) {
  const { t, i18n } = useTranslation(WORKFLOW_NS);
  const overview = useRequest(() => unwrap(fetchPublishOverview(workflowId)));

  if (overview.loading) {
    return (
      <div aria-busy="true" aria-label={t("log.loading")} className="flex flex-col gap-2" role="status">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  if (overview.error || !overview.data) {
    // 失败不退回空态：给重试（读取本身可恢复），文案按固定键而非服务端原文（§9.3）。
    return (
      <EmptyState
        icon={<TriangleAlert className={ICON_CLASS} />}
        title={t("log.failed_title")}
        description={t("log.failed_hint")}
        tone="danger"
        className="py-8"
        role="alert"
        action={{
          label: t("log.retry"),
          icon: <RefreshCw />,
          disabled: overview.loading,
          onClick: () => overview.refresh(),
        }}
      />
    );
  }

  const { current, records } = overview.data;
  const drift = resolvePublishDrift(localPublishedVersion, current.publishedVersion);
  const rows = records.map((record, index) => toPublishRecordRow(record, index, workflowName));

  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
      <section className="flex flex-col gap-1 rounded-lg border border-border-subtle px-3 py-2">
        <VersionRow label={t("log.current_upstream")} version={current.publishedVersion} none={t("log.current_none")} />
        <VersionRow label={t("log.current_local")} version={localPublishedVersion} none={t("log.current_none")} />
        {drift.kind === "drift" ? (
          // 漂移是要暴露的状态：画布内发布不写回本地版本，下一次控制台发布会撞上「版本未自增」。
          <p className="mt-1 flex items-start gap-1.5 text-xs text-warning-text" role="alert">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            {t("log.drift_hint")}
          </p>
        ) : null}
        {drift.kind === "match" ? <p className="mt-1 text-xs text-text-muted">{t("log.drift_match")}</p> : null}
      </section>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Inbox className={ICON_CLASS} />}
          title={t("log.empty_title")}
          description={t("log.empty_hint")}
          tone="neutral"
          className="py-8"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-1 rounded-lg border border-border-subtle px-3 py-2">
              <span className="text-sm font-medium">{row.name}</span>
              <span className="text-xs text-text-muted">
                {t("log.record_published_at", {
                  time: formatPublishTime(row.publishedAt, i18n.language) ?? t("log.record_value_unknown"),
                })}
              </span>
              <span className="text-xs text-text-muted">
                {t("log.record_owner", { owner: row.ownerId ?? t("log.record_value_unknown") })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WorkflowLogDialog({
  open,
  onOpenChange,
  workflowId,
  workflowName,
  localPublishedVersion,
}: WorkflowLogDialogProps) {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG_CONTENT_CLASS}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4" />
            {t("log.title", { name: workflowName })}
          </DialogTitle>
          <DialogDescription>{t("log.description")}</DialogDescription>
        </DialogHeader>
        {workflowId === null ? null : (
          <WorkflowLogBody
            workflowId={workflowId}
            workflowName={workflowName}
            localPublishedVersion={localPublishedVersion}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
