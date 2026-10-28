/**
 * 预览面板：只渲染 `useCloudDrivePreview` 给出的状态，不自己发请求。
 *
 * 与对话框外壳分开是为了可测：面板不依赖 Radix Portal / 焦点陷阱，测试可以直接挂载并断言加载、错误、
 * 不支持、页图与分页行为；对话框只负责 dialog 语义、标题与关闭。
 */

import { MessageResponse } from "@fenix/ui-components/chat/primitives/message";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { ChevronLeft, ChevronRight, Download, FileQuestion, RotateCw } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cloudDriveApi } from "../../api/cloud-drive";
import { useCloudDrivePreview } from "../../hooks/use-cloud-drive-preview";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import type { CloudDriveFile } from "../../types/cloud-drive";

interface CloudDrivePreviewPanelProps {
  file: CloudDriveFile;
}

/** 文件预览主体：markdown 文档、栅格页图或明确的不支持/错误提示。 */
export function CloudDrivePreviewPanel({ file }: CloudDrivePreviewPanelProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);
  const { state, page, pageCount, setPage, retry, retryConversion, retryingConversion, loadMore } =
    useCloudDrivePreview(true, file);
  const [pageDraft, setPageDraft] = useState("1");
  const [fitWidth, setFitWidth] = useState(true);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setPageDraft(String(page));
    setImageFailed(false);
  }, [page]);

  const commitPage = (event?: FormEvent) => {
    event?.preventDefault();
    const parsed = Number.parseInt(pageDraft, 10);
    if (!Number.isFinite(parsed)) {
      setPageDraft(String(page));
      return;
    }
    setPage(Math.min(Math.max(parsed, 1), Math.max(pageCount, 1)));
  };

  const download = (
    <Button asChild variant="outline" size="sm">
      <a href={cloudDriveApi.contentUrl(file.id)}>
        <Download aria-hidden />
        {t("preview.download")}
      </a>
    </Button>
  );

  if (state.status === "loading" || state.status === "idle") {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3" role="status" aria-live="polite">
        <Spinner size="sm" />
        <p className="text-sm text-text-muted">{t("preview.loading")}</p>
      </div>
    );
  }

  if (state.status === "processing") {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3" role="status" aria-live="polite">
        <Spinner size="sm" />
        <p className="text-sm font-medium">{t("preview.processing")}</p>
        <p className="max-w-sm text-center text-xs text-text-muted">{t("preview.processingHint")}</p>
      </div>
    );
  }

  if (state.status === "unsupported") {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
        <FileQuestion className="size-8 text-text-muted" aria-hidden />
        <p className="text-sm font-medium">{t("preview.unsupportedTitle")}</p>
        <p className="max-w-sm text-xs text-text-muted">{t("preview.unsupportedHint")}</p>
        {download}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center" role="alert">
        <p className="text-sm font-medium text-destructive">{t("preview.errorTitle")}</p>
        <p className="max-w-md text-sm text-text-muted">{state.message}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {state.canRetry && (
            <Button size="sm" variant="outline" onClick={retry}>
              <RotateCw aria-hidden />
              {t("preview.retry")}
            </Button>
          )}
          {state.canRetryConversion && (
            <Button size="sm" onClick={() => void retryConversion()} disabled={retryingConversion}>
              {retryingConversion ? <Spinner size="xs" variant="inline" /> : <RotateCw aria-hidden />}
              {retryingConversion ? t("preview.retryingConversion") : t("preview.retryConversion")}
            </Button>
          )}
          {download}
        </div>
        {state.canRetryConversion && <p className="text-xs text-text-muted">{t("preview.conversionFailed")}</p>}
      </div>
    );
  }

  if (state.status === "markdown") {
    return (
      <div className="flex min-h-0 flex-col gap-3">
        <div className="max-h-[65vh] overflow-auto rounded-md border p-4">
          {state.content.trim() ? (
            <MessageResponse>{state.content}</MessageResponse>
          ) : (
            <p className="text-sm text-text-muted">{t("preview.empty")}</p>
          )}
        </div>
        {state.truncated && <p className="text-xs text-text-muted">{t("preview.truncated")}</p>}
        {state.nextCursor && (
          <div className="flex justify-center">
            <Button size="sm" variant="outline" onClick={() => void loadMore()} disabled={state.loadingMore}>
              {state.loadingMore && <Spinner size="xs" variant="inline" className="text-current" />}
              {state.loadingMore ? t("preview.loadingMore") : t("preview.loadMore")}
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (state.manifest.pageCount === 0) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm text-text-muted">{t("preview.empty")}</p>
        {download}
      </div>
    );
  }

  const pageUrl = cloudDriveApi.previewPageUrl(file.id, page, state.manifest.versionId);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="group" aria-label={t("preview.pageNav")}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("preview.prevPage")}
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") setPage(page - 1);
            }}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <form onSubmit={commitPage} className="flex items-center gap-1">
            <label htmlFor="cloud-drive-preview-page" className="sr-only">
              {t("preview.pageInput")}
            </label>
            <Input
              id="cloud-drive-preview-page"
              type="number"
              min={1}
              max={Math.max(pageCount, 1)}
              value={pageDraft}
              onChange={(event) => setPageDraft(event.target.value)}
              onBlur={() => commitPage()}
              className="h-8 w-16 text-center"
            />
            <span className="text-xs text-text-muted">/ {pageCount}</span>
          </form>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("preview.nextPage")}
            disabled={page >= pageCount}
            onClick={() => setPage(page + 1)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") setPage(page + 1);
            }}
          >
            <ChevronRight aria-hidden />
          </Button>
          <span aria-live="polite" className="sr-only">
            {t("preview.pageOf", { page, total: pageCount })}
          </span>
        </div>
        <Button size="sm" variant="outline" aria-pressed={!fitWidth} onClick={() => setFitWidth((value) => !value)}>
          {fitWidth ? t("preview.actualSize") : t("preview.fitWidth")}
        </Button>
      </div>

      <div className="max-h-[65vh] min-h-48 overflow-auto rounded-md border bg-surface-1">
        {imageFailed ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 p-4 text-center" role="alert">
            <p className="text-sm text-destructive">{t("preview.imageFailed")}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setImageFailed(false);
                retry();
              }}
            >
              <RotateCw aria-hidden />
              {t("preview.retry")}
            </Button>
          </div>
        ) : (
          <img
            key={pageUrl}
            src={pageUrl}
            alt={t("preview.pageAlt", { name: file.name, page })}
            className={fitWidth ? "mx-auto block h-auto max-w-full" : "mx-auto block h-auto max-w-none"}
            onError={() => setImageFailed(true)}
          />
        )}
      </div>
    </div>
  );
}
