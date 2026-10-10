// pages/list/workflow-log-dialog.tsx
// 「日志」弹窗：列表行操作「日志」打开的独立弹窗，回答「这个 workflow 发布过什么、上游现在认的版本是哪个」。
//
// 数据来自两处、分段呈现，各段为空就是那一侧确实没有记录（不互相填充，见 `src/server/services/workflow-publish-records.ts`）：
// - 「上游当前发布版本」与「渠道发布记录」来自上游（canvas 的 `workflow_version` 与**应用级**渠道发布记录
//   `intelligence_api/publish/publish_record_list`——工作流级的 `list_publish_workflow` 在该上游构建是桩实现）；
// - 「平台发布动作」来自平台自己的审计流水（时间、操作人、结果），回答「我在控制台点过的发布结果如何」。
//
// 只呈现上游版本，**没有**「本地版本」这一行：平台不维护版本镜像（用户口径「不做版本管理」），既有的本地列
// 已不再读写，把两个版本并排比对只会让用户以为存在两套版本。
//
// 三态（§3.4）：loading → 骨架；error → `EmptyState` + 重试（`role="alert"`）；ready → 上游版本 + 记录列表
// （记录为空时给空态而不是空列表）。失败**不映射成空态**——「上游读不到」与「上游说没有」是两件事。
//
// 关闭即卸载：Radix 在关闭态不渲染 `DialogContent`，取数由此天然只在打开时发生（重新打开即重取，不需要手工
// 复位状态）；`workflowId` 为 null（列表尚未给出目标）时正文不挂载，避免拿空身份发请求。

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge, type StatusTone } from "@fenix/ui-components/config/StatusBadge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { History, Inbox, RefreshCw, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchPublishOverview } from "../../api/workflow-publish";
import { WORKFLOW_NS } from "../../i18n/namespace";
import {
  formatPublishTime,
  PUBLISH_ACTION_RESULT_KEYS,
  PUBLISH_CHANNEL_STATUS_KEYS,
  PUBLISH_RECORD_STATUS_KEYS,
  toPublishRecordRow,
} from "./workflow-publish-model";

export interface WorkflowLogDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 本地主键；null 表示目标未确定，此时不取数。 */
  readonly workflowId: string | null;
  /** 记录名缺失时的兜底展示名（当前 workflow 的名称）。 */
  readonly workflowName: string;
}

/** 弹窗尺寸：记录列表是单列文本块，`sm:max-w-2xl` 与同类查看弹窗一致。 */
const DIALOG_CONTENT_CLASS = "sm:max-w-2xl";

/** 图标统一尺寸（不写尺寸类时 lucide 用默认 24px，与包内其它状态块不一致）。 */
const ICON_CLASS = "size-6";

/** 记录级状态 → 色调（配色留给组件库，这里只声明语义）。 */
const RECORD_STATUS_TONES: Record<string, StatusTone> = {
  done: "success",
  pack_failed: "danger",
  in_progress: "neutral",
};

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
function WorkflowLogBody({ workflowId }: { readonly workflowId: string }) {
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

  const { current, records, actions } = overview.data;
  const rows = records.map((record, index) => toPublishRecordRow(record, index));

  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
      <section className="flex flex-col gap-1 rounded-lg border border-border-subtle px-3 py-2">
        <VersionRow label={t("log.current_upstream")} version={current.publishedVersion} none={t("log.current_none")} />
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
              <span className="flex items-center gap-2 text-sm font-medium">
                {t("log.record_version", { version: row.version ?? t("log.record_value_unknown") })}
                <StatusBadge
                  status={row.status}
                  label={t(PUBLISH_RECORD_STATUS_KEYS[row.status])}
                  tone={RECORD_STATUS_TONES[row.status]}
                />
              </span>
              {row.channels.length === 0 ? null : (
                <span className="text-xs text-text-muted">
                  {t("log.record_channels", {
                    channels: row.channels
                      .map(
                        (channel) =>
                          `${channel.name}（${t(
                            PUBLISH_CHANNEL_STATUS_KEYS[channel.status ?? "unknown"] ??
                              PUBLISH_CHANNEL_STATUS_KEYS.unknown,
                          )}）`,
                      )
                      .join("、"),
                  })}
                </span>
              )}
              {row.packFailedResources.length === 0 ? null : (
                <span className="text-xs text-text-muted">
                  {t("log.record_pack_failed", { names: row.packFailedResources.join("、") })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/*
        平台侧发布动作：列表页用户自己的发布动作在**上游没有任何记录**（上游只记录发布产物），这一段来自本平台
        审计流水（时间 + 操作人 + 结果），是「我点过的发布结果如何」的唯一来源；为空时不渲染整段，不给用户看
        一个恒空的标题。
      */}
      {actions.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">{t("log.actions_title")}</span>
          <ul className="flex flex-col gap-1">
            {actions.map((action) => (
              <li
                // 键取「时刻 + 结果」：同一次发布不会在同一毫秒产生两条不同结果的动作（避免把序号当键）。
                key={`${action.occurredAt}-${action.result}`}
                className="flex flex-col gap-1 rounded-lg border border-border-subtle px-3 py-2 text-xs"
              >
                <span className="text-text-muted">
                  {t("log.action_time", {
                    time: formatPublishTime(action.occurredAt, i18n.language) ?? t("log.record_value_unknown"),
                  })}
                </span>
                {action.actorName === null ? null : (
                  <span className="text-text-muted">{t("log.action_actor", { name: action.actorName })}</span>
                )}
                <span className="text-text-muted">
                  {t("log.action_result", {
                    result: PUBLISH_ACTION_RESULT_KEYS[action.result]
                      ? t(PUBLISH_ACTION_RESULT_KEYS[action.result])
                      : action.result,
                  })}
                </span>
                {action.errorCode === null ? null : (
                  <span className="text-text-muted">{t("log.action_error", { code: action.errorCode })}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function WorkflowLogDialog({ open, onOpenChange, workflowId, workflowName }: WorkflowLogDialogProps) {
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
        {workflowId === null ? null : <WorkflowLogBody workflowId={workflowId} />}
      </DialogContent>
    </Dialog>
  );
}
