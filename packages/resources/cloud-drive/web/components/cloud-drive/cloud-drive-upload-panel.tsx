import { Button } from "@fenix/ui-components/ui/button";
import { Progress } from "@fenix/ui-components/ui/progress";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CloudDriveUploadTask } from "../../hooks/use-cloud-drive-uploads";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import { uploadPercent } from "../../lib/format";

/** 全部完成后自动隐藏的延迟：留出时间让用户看到「已上传」，又不长期占住右下角。 */
export const UPLOAD_AUTO_HIDE_DELAY_MS = 2_000;

interface CloudDriveUploadPanelProps {
  tasks: readonly CloudDriveUploadTask[];
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onClearFinished: () => void;
}

/**
 * 上传队列浮层：右下角固定定位，逐文件进度、失败原因（服务端原文）、重试、取消与关闭。
 *
 * 显示规则：有进行中或失败条目时显示；全部完成后延迟 {@link UPLOAD_AUTO_HIDE_DELAY_MS} 自动隐藏；
 * 失败条目不会自动隐藏；关闭/清除立即隐藏；出现新的任务 ID 时重新显示。
 */
export function CloudDriveUploadPanel({ tasks, onRetry, onCancel, onClearFinished }: CloudDriveUploadPanelProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);
  const [hidden, setHidden] = useState(false);
  /** 已出现过的任务 ID：进度更新会重建 tasks 数组，只有**新 ID** 才代表「新上传」。 */
  const seenTaskIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const hasUnseenTask = tasks.some((task) => !seenTaskIds.current.has(task.id));
    seenTaskIds.current = new Set(tasks.map((task) => task.id));
    if (hasUnseenTask) setHidden(false);
  }, [tasks]);

  const allFinished = tasks.length > 0 && tasks.every((task) => task.status === "done" || task.status === "canceled");

  useEffect(() => {
    if (hidden || !allFinished) return;
    const timer = setTimeout(() => setHidden(true), UPLOAD_AUTO_HIDE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hidden, allFinished]);

  if (tasks.length === 0 || hidden) return null;

  const hasFinished = tasks.some((task) => task.status === "done" || task.status === "canceled");

  const statusLabel = (task: CloudDriveUploadTask): string => {
    switch (task.status) {
      case "queued":
        return t("upload.queued");
      case "uploading":
        return t("upload.uploading", { percent: uploadPercent(task.uploadedBytes, task.sizeBytes) });
      case "finalizing":
        return t("upload.finalizing");
      case "done":
        return t("upload.done");
      case "error":
        return t("upload.failed");
      default:
        return t("upload.canceled");
    }
  };

  return (
    <section
      aria-label={t("upload.title")}
      className="fixed bottom-4 left-4 right-4 z-50 rounded-lg border bg-card shadow-lg sm:left-auto sm:w-96"
    >
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">{t("upload.title")}</h2>
        <div className="flex shrink-0 items-center gap-1">
          {hasFinished && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                onClearFinished();
                setHidden(true);
              }}
            >
              {t("upload.clearFinished")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("upload.close")}
            title={t("upload.close")}
            onClick={() => setHidden(true)}
          >
            <X aria-hidden />
          </Button>
        </div>
      </header>
      <ul className="max-h-96 divide-y overflow-y-auto">
        {tasks.map((task) => {
          const percent = uploadPercent(task.uploadedBytes, task.sizeBytes);
          const active = task.status === "uploading" || task.status === "finalizing";
          const retryable = task.status === "error" || task.status === "canceled";
          return (
            <li key={task.id} className="space-y-1.5 px-4 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm" title={task.name}>
                  {task.name}
                </span>
                <span className="shrink-0 text-xs text-text-muted">{statusLabel(task)}</span>
              </div>
              {(active || task.status === "done") && (
                <Progress value={percent} aria-label={t("a11y.uploadProgress", { name: task.name })} />
              )}
              {task.message && <p className="text-xs text-destructive">{task.message}</p>}
              <div className="flex items-center justify-end gap-1">
                {retryable && (
                  <Button size="xs" variant="outline" onClick={() => onRetry(task.id)}>
                    {t("upload.retry")}
                  </Button>
                )}
                {(active || task.status === "queued") && (
                  <Button size="xs" variant="ghost" onClick={() => onCancel(task.id)}>
                    {t("upload.cancel")}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
