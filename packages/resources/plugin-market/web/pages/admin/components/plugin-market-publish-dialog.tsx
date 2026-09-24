// plugin-market-publish-dialog.tsx — 管理台发布插件版本的弹窗（预览 → 确认两步）
//
// 源项目的后台也是两步（`/admin/publish/preview` → `/admin/publish`），本弹窗把同一件事落在 React 上：
// 用户先按包名 + 精确版本**读取并规范化**私有源上的元数据，看到「即将公开的内容」之后再确认落库。
//
// 为什么必须是两步而不是一次提交：落库的是一份**发布后不可变的快照**。一步提交意味着用户在没看到内容的
// 前提下把私有源上任意东西公开到市场；两步提交让「确认」有实际指向——用户确认的是眼前这一份摘要。
//
// 409 `PREVIEW_CHANGED` 的处理是这段流程的核心（见 `runPublish`）：预览与确认之间私有源上的内容可能已被
// 替换，后端重新读取并比对摘要，不一致就以 409 把**新读到的快照**交回来。此时弹窗不重开、不丢上下文，
// 只是把预览换成新快照并要求再确认一次——用户在旧快照上点的那次确认被明确作废，而不是被静默吞掉。
//
// 表单形态按 §4.3：字段体（`plugin-market-publish-form`）经 `useFormContext` 绑到 `FormDialog` 内部创建的
// `useForm`，弹窗自己不持有字段值、不写校验；重置靠容器每次打开自增的 `key`（§4.2），不写 `reset()`。
// 两步的按钮分工由此变得明确：**提交按钮只做第一步**（读取并预览，受 zod 必填校验保护），确认发布是预览
// 面板里的独立动作——它在预览态按 `hideSubmit` 替掉提交按钮，因此不必给字段挂 `disabled` 后仍走表单提交。
//
// 凭据：两条写请求都走 `/api/system/*`（系统 master key，见 `../../../api/system-plugin-market`）。这两个
// 请求刻意不做 `unwrap`——409 冲突体必须原样交到这里；代价是凭据失效只能按**信封里的码**识别（见两处
// `onAuthFailure` 的调用点）。
//
// 上屏文案一律取本包字典（§9.3）：`ApiError.message` / 错误信封原文是后端文案，只进 `console.error`。

import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { Button } from "@fenix/ui-components/ui/button";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { z } from "zod/v4";
import { systemPluginMarketApi } from "../../../api/system-plugin-market";
import type { PluginPublicationChange } from "../../../api/system-plugin-market-types";
import { PLUGIN_MARKET_NS } from "../../../i18n/namespace";
import { type PreviewSnapshot, readPreviewChangedPayload } from "../../../lib/plugin-market-admin-utils";
import { isAccessDeniedCode } from "../../../lib/plugin-market-utils";
import { PluginPublishForm, type PluginPublishFormValues, pluginPublishFormSchema } from "./plugin-market-publish-form";

type PublishDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 发布完成（含幂等 noop）：提示、刷新列表与切换选中项由容器负责。 */
  onPublished: (change: PluginPublicationChange) => void;
  /** 请求带回了授权失败（master key 失效）：容器清 key 并把用户送回门，弹窗不自行提示。 */
  onAuthFailure: () => void;
};

export function PluginMarketPublishDialog({ open, onOpenChange, onPublished, onAuthFailure }: PublishDialogProps) {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  // 流程态与表单态分开：字段值在 `FormDialog` 的 `useForm` 里，这里只留「请求进行到哪一步」。
  const [preview, setPreview] = useState<PreviewSnapshot | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  /** 第一步：读取并规范化私有源上的元数据。取值已由 schema `.trim()` 规整，这里不再二次修剪。 */
  const runPreview = useCallback(
    async (target: PluginPublishFormValues) => {
      setActionError(null);
      setConflict(false);
      setPreviewing(true);
      try {
        const response = await systemPluginMarketApi.preview({
          packageName: target.packageName,
          exactVersion: target.exactVersion,
        });
        if (!response.success) {
          console.error(t("dialog.previewFailed"), response.error);
          // 凭据失效不是「读取失败」：回门重新输入 key 才有意义，在弹窗里提示只会让人反复重试同一个失败。
          if (isAccessDeniedCode(response.error?.code)) {
            onOpenChange(false);
            onAuthFailure();
            return;
          }
          setActionError(t("dialog.previewFailed"));
          return;
        }
        setPreview(response.data?.preview ?? null);
      } finally {
        setPreviewing(false);
      }
    },
    [onAuthFailure, onOpenChange, t],
  );

  /** 第二步：确认发布预览那一份。定位符取自 `preview` 而不是输入框（见文件头的两步说明）。 */
  const runPublish = useCallback(async () => {
    if (!preview) return;
    setActionError(null);
    setPublishing(true);
    try {
      const response = await systemPluginMarketApi.publish({
        packageName: preview.packageName,
        exactVersion: preview.exactVersion,
        previewDigest: preview.metadataDigest,
      });
      if (response.success && response.data) {
        onPublished(response.data.change);
        onOpenChange(false);
        return;
      }
      const refreshed = readPreviewChangedPayload(response.error);
      if (refreshed) {
        // 原位换上新快照并保留「已变化」提示：用户要么在新内容上再确认一次，要么返回修改。
        setPreview(refreshed);
        setConflict(true);
        return;
      }
      if (isAccessDeniedCode(response.error?.code)) {
        onOpenChange(false);
        onAuthFailure();
        return;
      }
      console.error(t("dialog.publishFailed"), response.error);
      setActionError(t("dialog.publishFailed"));
    } finally {
      setPublishing(false);
    }
  }, [onAuthFailure, onOpenChange, onPublished, preview, t]);

  // `onFormSubmit` 的入参是 `Record<string, unknown>`（`FormDialog` 的契约），按域类型收窄后再用。
  const formConfig = useMemo(
    () => ({
      schema: pluginPublishFormSchema as z.ZodType<Record<string, unknown>>,
      defaultValues: { packageName: "", exactVersion: "" } as unknown as Record<string, unknown>,
      onFormSubmit: (values: Record<string, unknown>) => {
        void runPreview(values as unknown as PluginPublishFormValues);
      },
    }),
    [runPreview],
  );

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("dialog.publishTitle")}
      formConfig={formConfig}
      submitLabel={t("btn.preview")}
      loading={previewing}
      // 有预览时提交按钮让位给预览面板里的「确认发布」：确认动作的定位符不是输入框内容，
      // 继续走表单提交会把它和字段校验绑在一起（字段此时被锁，提交只会失败得莫名其妙）。
      hideSubmit={preview !== null}
      width="sm:max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs leading-5 text-text-muted">{t("dialog.publishDescription")}</p>

        <PluginPublishForm locked={preview !== null} />

        {actionError ? (
          <p className="text-sm text-destructive" role="alert">
            {actionError}
          </p>
        ) : null}

        {conflict ? (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-sm" role="status">
            {t("dialog.previewChanged")}
          </p>
        ) : null}

        {preview ? (
          <PreviewPanel
            preview={preview}
            publishing={publishing}
            onBack={() => setPreview(null)}
            onConfirm={() => void runPublish()}
          />
        ) : (
          <p className="text-xs text-text-muted" role="status">
            {previewing ? t("btn.previewing") : t("dialog.previewHint")}
          </p>
        )}
      </div>
    </FormDialog>
  );
}

/** 预览面板的一行「字段名 + 取值」；字段名定宽、取值自适应并换行（与详情面同一套刻度）。 */
function PreviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-text-muted">{label}</dt>
      <dd className={`min-w-0 flex-1 break-all ${mono ? "font-mono text-xs" : ""}`.trim()}>{value}</dd>
    </div>
  );
}

/** 预览面板：只渲染后端规范化后真正会公开的字段，摘要原样展示（它就是用户确认的凭据）。 */
function PreviewPanel({
  preview,
  publishing,
  onBack,
  onConfirm,
}: {
  preview: PreviewSnapshot;
  publishing: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  const metadata = preview.metadata;
  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{t("dialog.previewHeading")}</h3>
        <div className="flex items-center gap-2">
          {/* 两个按钮都在 `<form>` 内，必须显式 `type="button"`，否则会触发提交。 */}
          <Button type="button" variant="outline" size="sm" onClick={onBack} disabled={publishing}>
            {t("btn.back")}
          </Button>
          <Button type="button" size="sm" onClick={onConfirm} disabled={publishing}>
            {publishing ? t("btn.publishing") : t("btn.confirmPublish")}
          </Button>
        </div>
      </div>
      <dl className="flex flex-col gap-2 text-sm">
        <PreviewRow label={t("dialog.packageName")} value={preview.packageName} mono />
        <PreviewRow label={t("dialog.exactVersion")} value={preview.exactVersion} mono />
        {metadata.displayName ? (
          <PreviewRow
            label={t("detail.description")}
            value={metadata.summary ?? metadata.description ?? metadata.displayName}
          />
        ) : null}
        <PreviewRow
          label={t("dialog.previewMembers")}
          value={`${metadata.agents.length} · ${metadata.skills.length} · ${metadata.servers.length}`}
        />
        <PreviewRow label={t("dialog.previewDigest")} value={preview.metadataDigest} mono />
      </dl>
    </section>
  );
}
