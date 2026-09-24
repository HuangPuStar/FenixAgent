// plugin-market-publish-dialog.tsx — 发布插件版本的弹窗（预览 → 确认两步）
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

import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { LabeledField } from "@fenix/ui-components/config/LabeledField";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { pluginMarketApi } from "../../../api/plugin-market";
import type { PluginPublicationChange } from "../../../api/plugin-market-types";
import { PLUGIN_MARKET_NS } from "../../../i18n/namespace";
import { type PreviewSnapshot, readPreviewChangedPayload, validatePublishTarget } from "./plugin-market-utils";

type PublishDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 发布完成（含幂等 noop）：提示、刷新列表与切换选中项由容器负责。 */
  onPublished: (change: PluginPublicationChange) => void;
};

const EMPTY_FORM = { packageName: "", exactVersion: "" };

export function PluginMarketPublishDialog({ open, onOpenChange, onPublished }: PublishDialogProps) {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  const [form, setForm] = useState(EMPTY_FORM);
  const [preview, setPreview] = useState<PreviewSnapshot | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const reset = useCallback(() => {
    setForm(EMPTY_FORM);
    setPreview(null);
    setPreviewing(false);
    setPublishing(false);
    setError(null);
    setConflict(false);
  }, []);

  const runPreview = async () => {
    const validationKey = validatePublishTarget(form.packageName, form.exactVersion);
    if (validationKey) {
      setError(t(validationKey));
      return;
    }
    setError(null);
    setConflict(false);
    setPreviewing(true);
    try {
      const response = await pluginMarketApi.preview({
        packageName: form.packageName.trim(),
        exactVersion: form.exactVersion.trim(),
      });
      if (!response.success) {
        setError(response.error?.message ?? t("dialog.previewUnavailable"));
        return;
      }
      setPreview(response.data?.preview ?? null);
    } finally {
      setPreviewing(false);
    }
  };

  const runPublish = async () => {
    if (!preview) return;
    setError(null);
    setPublishing(true);
    try {
      const response = await pluginMarketApi.publish({
        // 确认的是**预览那一份**的定位符，不是输入框当前内容：字段在预览态被禁用（下面 `disabled`），
        // 这里再用预览自带的取值，两处一致，避免「摘要来自 A、定位符被改成 B」这种半改状态。
        packageName: preview.packageName,
        exactVersion: preview.exactVersion,
        previewDigest: preview.metadataDigest,
      });
      if (response.success && response.data) {
        onPublished(response.data.change);
        reset();
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
      setError(response.error?.message ?? t("toast.publishFailed"));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={t("dialog.publishTitle")}
      // 一次提交按钮承担两个动作：还没有预览时是「读取并预览」，有预览时是「确认发布」。
      onSubmit={preview ? runPublish : runPreview}
      submitLabel={preview ? t("btn.confirmPublish") : t("btn.preview")}
      loading={previewing || publishing}
      width="sm:max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs leading-5 text-text-muted">{t("dialog.publishDescription")}</p>

        <LabeledField label={t("dialog.packageName")}>
          <Input
            value={form.packageName}
            onChange={(event) => setForm({ ...form, packageName: event.target.value })}
            disabled={preview !== null}
            placeholder={t("dialog.packageNamePlaceholder")}
            className="font-mono text-sm"
            autoComplete="off"
          />
        </LabeledField>

        <LabeledField label={t("dialog.exactVersion")}>
          <Input
            value={form.exactVersion}
            onChange={(event) => setForm({ ...form, exactVersion: event.target.value })}
            disabled={preview !== null}
            placeholder={t("dialog.exactVersionPlaceholder")}
            className="font-mono text-sm"
            autoComplete="off"
          />
        </LabeledField>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {conflict ? (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-sm" role="status">
            {t("dialog.previewChanged")}
          </p>
        ) : null}

        {preview ? (
          <PreviewPanel preview={preview} onBack={() => setPreview(null)} />
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
function PreviewPanel({ preview, onBack }: { preview: PreviewSnapshot; onBack: () => void }) {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  const metadata = preview.metadata;
  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{t("dialog.previewHeading")}</h3>
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          {t("btn.back")}
        </Button>
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
