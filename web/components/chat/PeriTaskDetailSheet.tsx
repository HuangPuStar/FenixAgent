import type { PeriTaskViewProjection } from "@fenix/chat-channel";
import { AlertCircle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPeriTaskDetail, type PeriTaskDetail } from "../../src/api/peri-task-details";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";

interface PeriTaskDetailSheetProps {
  environmentId: string;
  sessionId: string;
  task: PeriTaskViewProjection | null;
  onClose: () => void;
}

/** 打开时才读取详情；关闭或切换 task 会取消旧请求并阻止 stale response 覆盖。 */
export function PeriTaskDetailSheet({ environmentId, sessionId, task, onClose }: PeriTaskDetailSheetProps) {
  const { t } = useTranslation("components");
  const [detail, setDetail] = useState<PeriTaskDetail | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const requestVersion = useRef(0);

  useEffect(() => {
    if (!task) return;
    // retryVersion 是显式重试触发器，不参与请求参数。
    void retryVersion;
    const controller = new AbortController();
    const version = ++requestVersion.current;
    setDetail(null);
    setError(false);
    setLoading(true);
    void getPeriTaskDetail(environmentId, sessionId, task.taskId, controller.signal).then(
      (value) => {
        if (version !== requestVersion.current) return;
        setDetail(value);
        setLoading(false);
      },
      (reason: unknown) => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setError(true);
        setLoading(false);
        void reason;
      },
    );
    return () => {
      requestVersion.current += 1;
      controller.abort();
    };
  }, [environmentId, sessionId, task, retryVersion]);

  return (
    <Sheet open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-lg flex flex-col">
        <SheetHeader>
          <SheetTitle>{task?.title ?? t("periTask.detailTitle")}</SheetTitle>
          <SheetDescription>
            {task?.kind === "background" ? t("periTask.kindBackground") : t("periTask.kindSubagent")}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-text-muted" role="status">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("periTask.detailLoading")}
            </div>
          ) : error ? (
            <div className="space-y-3" role="alert">
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" /> {t("periTask.detailLoadFailed")}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setRetryVersion((version) => version + 1)}>
                  {t("periTask.detailRetry")}
                </Button>
                <Button variant="outline" size="sm" onClick={onClose}>
                  {t("periTask.detailClose")}
                </Button>
              </div>
            </div>
          ) : detail?.kind === "preview" ? (
            <div className="space-y-3">
              <p className="text-xs text-text-muted">{t("periTask.previewOnly")}</p>
              {detail.items.map((item) => (
                <pre key={item.content} className="whitespace-pre-wrap break-words text-sm font-sans text-text-primary">
                  {item.content}
                </pre>
              ))}
            </div>
          ) : detail?.kind === "unavailable" ? (
            <p className="text-sm text-text-muted">
              {detail.reason === "expired" ? t("periTask.detailExpired") : t("periTask.detailUnavailable")}
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
