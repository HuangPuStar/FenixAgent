import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { Button } from "@fenix/ui-components/ui/button";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { type PageFullscreenState, usePageFullscreen } from "@fenix/ui-components/ui/use-page-fullscreen";
import { Download, Eye, Maximize2, Minimize2, RefreshCw, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EDITING_DEFAULTS } from "../../contracts";
import { getEditorLanguage, isMarkdownRichTextFile } from "../editors/editor-language";
import { FileEditor } from "../editors/file-editor";
import { LazyMarkdownEditor } from "../editors/lazy-markdown-editor";
import { OfficeEditor } from "../editors/office-editor";
import { isExpiredOfficeBuffer } from "../hooks/editing-errors";
import type { EditableKind, FileEditingController } from "../hooks/types";
import { FILE_EDITING_NS } from "../i18n/namespace";

/** An active editable file; keep Office panes mounted across tab switches. */
export interface EditingPaneProps {
  controller: FileEditingController;
  path: string;
  kind?: EditableKind;
  active?: boolean;
  /** The workspace decides whether switching to preview needs a save/discard decision. */
  onPreview?: () => void;
  /** Host-owned URL for downloading the saved workspace file without submitting the draft. */
  downloadUrl?: string;
  /** Shares the host's fullscreen choice when switching between preview and editing. */
  fullscreenState?: PageFullscreenState;
  className?: string;
}
/** Presents editor-local loading, save receipts, conflicts and retriable failures. */
export function EditingPane({
  controller,
  path,
  kind = "text",
  active = true,
  onPreview,
  downloadUrl,
  fullscreenState,
  className = "",
}: EditingPaneProps) {
  const { t } = useTranslation(FILE_EDITING_NS);
  const buffer = controller.buffers[path];
  const localFullscreen = usePageFullscreen(active && !fullscreenState);
  const { fullscreen, toggleFullscreen, fullscreenClassName } = fullscreenState ?? localFullscreen;
  const [discardOpen, setDiscardOpen] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [markdownMode, setMarkdownMode] = useState<"visual" | "source">("visual");
  const markdownFlush = useRef<(() => void) | null>(null);
  const officeSessionId = buffer?.session?.id;
  const { ensureLoaded, save, refreshOffice } = controller;
  const saveCurrent = useCallback(() => {
    markdownFlush.current?.();
    void save(path);
  }, [path, save]);
  const refreshCurrent = async () => {
    markdownFlush.current?.();
    if (buffer?.saving) await save(path);
    if (!(await controller.requestReload(path))) return;
    setProviderError(null);
    await ensureLoaded(path, kind);
  };
  // A hidden host can retain this pane after releasing buffers; activation must re-check the current file.
  useEffect(() => {
    if (active) void ensureLoaded(path, kind);
  }, [ensureLoaded, path, kind, active]);
  useEffect(() => {
    if (!officeSessionId) return;
    const timer = setInterval(() => {
      if (!document.hidden) void refreshOffice(path);
    }, EDITING_DEFAULTS.pollIntervalMs);
    const visible = () => {
      if (!document.hidden) void refreshOffice(path);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [officeSessionId, path, refreshOffice]);
  useEffect(() => {
    if (!active) return;
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !event.defaultPrevented) {
        event.preventDefault();
        saveCurrent();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [saveCurrent, active]);
  if (!buffer && controller.error)
    return (
      <div role="alert" className="flex items-center gap-2 p-3 text-sm text-red-500">
        {t(controller.error.message, { defaultValue: controller.error.message })}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void ensureLoaded(path, kind);
          }}
        >
          {t("retry")}
        </Button>
      </div>
    );
  if (!buffer) return <Spinner variant="panel" label={t("loading")} />;
  const expiredOffice = isExpiredOfficeBuffer(buffer);
  const error = expiredOffice
    ? "sessionExpired"
    : (buffer.error?.message ?? providerError ?? controller.error?.message);
  const loaded = buffer.kind === "office" ? Boolean(buffer.session) : Boolean(buffer.version);
  return (
    <section
      className={`flex h-full min-h-0 min-w-0 flex-col ${fullscreenClassName} ${className}`}
      aria-label={path}
      data-page-fullscreen={fullscreen && active}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate text-xs text-text-muted" role="status" aria-live="polite">
          {t(
            buffer.loading
              ? "loading"
              : buffer.saving
                ? "saving"
                : buffer.dirty
                  ? "unsaved"
                  : buffer.savedAt
                    ? "saved"
                    : "",
          )}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("discard")}
            title={t("discard")}
            disabled={!buffer.dirty || buffer.saving || buffer.loading || buffer.deleted}
            onClick={() => setDiscardOpen(true)}
          >
            <RotateCcw aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("save")}
            title={t("save")}
            disabled={
              !buffer.dirty || buffer.saving || buffer.loading || buffer.conflict || buffer.deleted || expiredOffice
            }
            onClick={saveCurrent}
          >
            <Save aria-hidden="true" />
          </Button>
          {onPreview && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("preview")}
              title={t("preview")}
              disabled={buffer.loading || buffer.saving}
              onClick={() => {
                markdownFlush.current?.();
                onPreview();
              }}
            >
              <Eye aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("refresh")}
            title={t("refresh")}
            onClick={() => {
              void refreshCurrent();
            }}
          >
            <RefreshCw aria-hidden="true" className={buffer.loading ? "animate-spin" : undefined} />
          </Button>
          {downloadUrl && (
            <Button variant="ghost" size="icon-sm" asChild>
              <a
                href={downloadUrl}
                download={path.split("/").pop() ?? path}
                aria-label={t("download")}
                title={t("download")}
              >
                <Download aria-hidden="true" />
              </a>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t(fullscreen ? "exitFullscreen" : "fullscreen")}
            title={t(fullscreen ? "exitFullscreen" : "fullscreen")}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </Button>
        </div>
      </div>
      {buffer.kind === "text" && isMarkdownRichTextFile(path) && (
        <div
          role="group"
          aria-label={t("markdownMode")}
          className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1"
        >
          {(["visual", "source"] as const).map((mode) => (
            <Button
              key={mode}
              variant={markdownMode === mode ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={markdownMode === mode}
              onClick={() => {
                markdownFlush.current?.();
                setMarkdownMode(mode);
              }}
            >
              {t(mode === "visual" ? "markdownVisual" : "markdownSource")}
            </Button>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t("discardTitle")}
        description={t("discardDescription")}
        confirmLabel={t("discard")}
        cancelLabel={t("cancel")}
        variant="destructive"
        onConfirm={() => {
          void controller.reload(path);
        }}
      />
      {buffer.conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border p-3 text-sm">
          <span>{t("conflict")}</span>
          <Button
            size="sm"
            onClick={() => {
              void controller.overwrite(path);
            }}
            disabled={buffer.saving}
          >
            {t("overwrite")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void controller.reload(path);
            }}
            disabled={buffer.saving}
          >
            {t("reload")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => controller.cancelConflict(path)}>
            {t("cancel")}
          </Button>
        </div>
      )}
      {error && !buffer.conflict && (
        <div role="alert" className="flex items-center gap-2 border-b border-border p-3 text-sm text-red-500">
          <span>{t(error, { defaultValue: error })}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setProviderError(null);
              if (expiredOffice) void refreshCurrent();
              else if (!loaded) void ensureLoaded(path, kind);
              else if (buffer.kind === "office") void refreshOffice(path);
              else void save(path);
            }}
          >
            {t(expiredOffice ? "refreshEditor" : "retry")}
          </Button>
        </div>
      )}
      {buffer.loading && !buffer.session ? (
        <Spinner variant="panel" label={t("loading")} />
      ) : (
        loaded && (
          <div className="min-h-0 flex-1 overflow-auto">
            {buffer.kind === "office" && buffer.session ? (
              <OfficeEditor
                session={buffer.session}
                onPrepareSave={(prepare) => controller.registerOfficeSave(path, prepare)}
                onDirty={(dirty) => controller.markOfficeDirty(path, dirty)}
                onError={setProviderError}
                onSave={() => {
                  void save(path);
                }}
                className="h-full"
              />
            ) : isMarkdownRichTextFile(path) && markdownMode === "visual" ? (
              <LazyMarkdownEditor
                value={buffer.content}
                readOnly={buffer.deleted}
                onChange={(content) => controller.updateContent(path, content)}
                onRegisterFlush={(flush) => {
                  markdownFlush.current = flush;
                  return () => {
                    if (markdownFlush.current === flush) markdownFlush.current = null;
                  };
                }}
                className="h-full"
              />
            ) : (
              <FileEditor
                value={buffer.content}
                language={getEditorLanguage(path)}
                readOnly={buffer.deleted}
                onChange={(content) => controller.updateContent(path, content)}
                onSave={saveCurrent}
                className="h-full"
              />
            )}
          </div>
        )
      )}
    </section>
  );
}
