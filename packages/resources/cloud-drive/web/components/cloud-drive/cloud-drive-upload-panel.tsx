import { Button } from "@fenix/ui-components/ui/button";
import { Progress } from "@fenix/ui-components/ui/progress";
import { useTranslation } from "react-i18next";
import type { CloudDriveUploadTask } from "../../hooks/use-cloud-drive-uploads";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import { uploadPercent } from "../../lib/format";

interface CloudDriveUploadPanelProps {
  tasks: readonly CloudDriveUploadTask[];
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onClearFinished: () => void;
}

/** 上传队列面板：逐文件进度、失败原因（服务端原文）、重试与取消。 */
export function CloudDriveUploadPanel({ tasks, onRetry, onCancel, onClearFinished }: CloudDriveUploadPanelProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);

  if (tasks.length === 0) return null;

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
    <section aria-label={t("upload.title")} className="rounded-lg border bg-card">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">{t("upload.title")}</h2>
        {hasFinished && (
          <Button variant="ghost" size="xs" onClick={onClearFinished}>
            {t("upload.clearFinished")}
          </Button>
        )}
      </header>
      <ul className="divide-y">
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
