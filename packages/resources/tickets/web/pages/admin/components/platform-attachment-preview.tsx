/**
 * 平台管理面的附件预览覆盖层：加载中骨架 / 放大图 / 失败与重试，外加关闭按钮与 Esc。
 *
 * **为什么不用共享的 `Dialog`**：Radix 覆盖层在 happy-dom 下不挂载（同进程实测内容为空），而这层的核心风险
 * 恰好是「blob 取回 + objectURL 生命周期 + 失败重试」——它必须可测。自建覆盖层的交互面很小（关闭按钮 + Esc
 * + 一个图片位），换来的是这条链路能在与其它用例同一套环境里被真实驱动。
 *
 * 键盘与读屏：面板是 `role="dialog"` + `aria-modal`，标题即附件名；打开时焦点落到关闭按钮（读屏立刻读到
 * 「关闭预览」，Tab 之后就是图片）；Esc 在任何焦点位置都生效（监听挂 `document`，面板还没拿到焦点时也管用）。
 *
 * 图片位在**每个状态**下都占着同一个区域（骨架与失败态都不塌陷成一行），避免加载完成时页面跳动。
 */

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { TICKETS_NS } from "../../../i18n/namespace";
import type { PlatformAttachmentPreviewStatus } from "../hooks/use-platform-attachment-preview";

export interface PlatformAttachmentPreviewProps {
  /** 附件名：进标题与 `alt`（读屏据此知道看的是哪个文件，`role="dialog"` 也由它命名）。 */
  name: string;
  status: PlatformAttachmentPreviewStatus;
  /** `ready` 时的图片地址（objectURL，由 hook 持有并负责释放）。 */
  url: string | null;
  /** 失败原因（服务端信封原文优先）；空则用字典文案。 */
  errorMessage: string | null;
  onRetry: () => void;
  onClose: () => void;
}

export function PlatformAttachmentPreview({
  name,
  status,
  url,
  errorMessage,
  onRetry,
  onClose,
}: PlatformAttachmentPreviewProps) {
  const { t } = useTranslation(TICKETS_NS);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Esc 关闭：监听挂 `document` 而不是面板自身——图片还在加载时焦点可能尚未进入面板，而 Esc 任何时刻都该管用。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 打开即把焦点交给关闭按钮：键盘用户不必先 Tab 一圈，读屏也立刻得知这是一层可关闭的预览。
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div
      aria-labelledby={titleId}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
    >
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col gap-3 rounded-md border border-border bg-surface-1 p-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 truncate text-sm font-medium text-text-primary" id={titleId}>
            {name}
          </h2>
          <Button aria-label={t("attachment.closePreview")} onClick={onClose} ref={closeRef} size="sm" variant="ghost">
            <X className="size-4" />
            {t("attachment.closePreview")}
          </Button>
        </div>

        {status === "loading" ? <Skeleton className="h-64 w-full" /> : null}

        {status === "failed" ? (
          <EmptyState
            action={{
              label: t("loadState.retry"),
              icon: <RefreshCw className="size-3.5" />,
              onClick: onRetry,
            }}
            description={errorMessage ?? t("attachment.previewFailed")}
            icon={<AlertTriangle className="size-6" />}
            role="alert"
            title={t("attachment.previewFailed")}
            tone="danger"
          />
        ) : null}

        {status === "ready" && url !== null ? (
          <img alt={name} className="max-h-[70vh] w-full object-contain" src={url} />
        ) : null}
      </div>
    </div>
  );
}
