/**
 * 云盘页面：文件浏览、新建/改名/移动/删除、上传队列、回收站与搜索的唯一容器。
 *
 * 页面不读路由参数：云盘只有一个顶级入口（`/agent/cloud-drive`），目录层级属于页面内状态。
 * 这样刷新页面会回到根目录——与「云盘是入口、不是深链系统」的首版定位一致；需要可分享的目录链接时
 * 再引入 `?parentId=`（届时同时要处理无权访问的回退）。
 */

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { unwrap } from "@fenix/web-runtime/api/request";
import { CloudOff, CloudUpload, FolderPlus, RefreshCw, Search, Upload } from "lucide-react";
import { type ChangeEvent, type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cloudDriveApi } from "../api/cloud-drive";
import { CloudDriveBreadcrumbs } from "../components/cloud-drive/cloud-drive-breadcrumbs";
import { CloudDriveDeleteDialog } from "../components/cloud-drive/cloud-drive-delete-dialog";
import { CloudDriveFileTable } from "../components/cloud-drive/cloud-drive-file-table";
import { CloudDriveMoveDialog } from "../components/cloud-drive/cloud-drive-move-dialog";
import { CloudDriveNameDialog } from "../components/cloud-drive/cloud-drive-name-dialog";
import { CloudDrivePreviewDialog } from "../components/cloud-drive/cloud-drive-preview-dialog";
import { CloudDriveQuota } from "../components/cloud-drive/cloud-drive-quota";
import { CloudDriveSearchPanel } from "../components/cloud-drive/cloud-drive-search-panel";
import { CloudDriveTrashPanel } from "../components/cloud-drive/cloud-drive-trash-panel";
import { CloudDriveUploadPanel } from "../components/cloud-drive/cloud-drive-upload-panel";
import { useCloudDriveFiles } from "../hooks/use-cloud-drive-files";
import { useCloudDriveQuota } from "../hooks/use-cloud-drive-quota";
import { useCloudDriveSearch } from "../hooks/use-cloud-drive-search";
import { useCloudDriveTrash } from "../hooks/use-cloud-drive-trash";
import { useCloudDriveUploads } from "../hooks/use-cloud-drive-uploads";
import { CLOUD_DRIVE_NS } from "../i18n/namespace";
import { cloudDriveErrorMessage } from "../lib/errors";
import type { CloudDriveBreadcrumb, CloudDriveFile, CloudDriveTrashEntry } from "../types/cloud-drive";

type CloudDriveView = "files" | "trash";

type DialogState =
  | { kind: "create" }
  | { kind: "rename"; file: CloudDriveFile }
  | { kind: "move"; file: CloudDriveFile }
  | { kind: "delete"; file: CloudDriveFile }
  | null;

/** 逐级向上读目录名，重建可点击的面包屑；超过 32 层视为异常并停在已解析的部分。 */
async function resolveTrail(parentId: string | null): Promise<CloudDriveBreadcrumb[]> {
  const trail: CloudDriveBreadcrumb[] = [];
  let currentId = parentId;
  for (let depth = 0; currentId && depth < 32; depth += 1) {
    const directory = await unwrap(cloudDriveApi.getFile(currentId));
    trail.unshift({ id: directory.id, name: directory.name });
    currentId = directory.parentId;
  }
  return trail;
}

export function CloudDrivePage() {
  const { t, i18n } = useTranslation(CLOUD_DRIVE_NS);
  const locale = i18n.language;
  const textOf = (error: unknown) => cloudDriveErrorMessage(error, (key) => String(t(key)));

  const [view, setView] = useState<CloudDriveView>("files");
  const [parentId, setParentId] = useState<string | null>(null);
  const [trail, setTrail] = useState<CloudDriveBreadcrumb[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [previewFile, setPreviewFile] = useState<CloudDriveFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const files = useCloudDriveFiles(parentId);
  const quota = useCloudDriveQuota();
  const trash = useCloudDriveTrash(view === "trash");
  const search = useCloudDriveSearch();
  const uploads = useCloudDriveUploads({
    onCompleted: () => {
      files.refresh();
      quota.refresh();
    },
  });

  const openPicker = () => fileInputRef.current?.click();

  const handlePicked = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    uploads.addFiles(picked, parentId);
  };

  const openDirectory = (file: CloudDriveFile) => {
    setParentId(file.id);
    setTrail((previous) => [...previous, { id: file.id, name: file.name }]);
  };

  const navigateTo = (targetId: string | null) => {
    if (targetId === null) {
      setParentId(null);
      setTrail([]);
      return;
    }
    const index = trail.findIndex((node) => node.id === targetId);
    if (index < 0) return;
    setTrail(trail.slice(0, index + 1));
    setParentId(targetId);
  };

  const clearSearch = () => {
    setSearchInput("");
    setSearchTerm("");
    search.reset();
  };

  const switchView = (next: CloudDriveView) => {
    setView(next);
    if (next === "trash") clearSearch();
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const term = searchInput.trim();
    if (!term) {
      clearSearch();
      return;
    }
    setSearchTerm(term);
    setView("files");
    void search.run(term);
  };

  const openLocation = async (fileId: string) => {
    setOpeningId(fileId);
    try {
      const file = await unwrap(cloudDriveApi.getFile(fileId));
      setTrail(await resolveTrail(file.parentId));
      setParentId(file.parentId);
      setView("files");
      clearSearch();
    } catch (error) {
      toast.error(t("search.locationFailed", { message: textOf(error) }));
    } finally {
      setOpeningId(null);
    }
  };

  const submitName = async (name: string) => {
    if (!dialog || (dialog.kind !== "create" && dialog.kind !== "rename")) return;
    setBusy(true);
    try {
      if (dialog.kind === "create") {
        await unwrap(cloudDriveApi.createDirectory({ name, parentId }));
        toast.success(t("dialogs.createSuccess"));
      } else {
        await unwrap(cloudDriveApi.moveFile(dialog.file.id, { name }));
        toast.success(t("dialogs.renameSuccess"));
      }
      setDialog(null);
      files.refresh();
    } catch (error) {
      toast.error(
        t(dialog.kind === "create" ? "dialogs.createFailed" : "dialogs.renameFailed", { message: textOf(error) }),
      );
    } finally {
      setBusy(false);
    }
  };

  const submitMove = async (targetParentId: string | null) => {
    if (dialog?.kind !== "move") return;
    setBusy(true);
    try {
      await unwrap(cloudDriveApi.moveFile(dialog.file.id, { parentId: targetParentId }));
      toast.success(t("dialogs.moveSuccess"));
      setDialog(null);
      files.refresh();
    } catch (error) {
      toast.error(t("dialogs.moveFailed", { message: textOf(error) }));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (dialog?.kind !== "delete") return;
    setBusy(true);
    try {
      await unwrap(cloudDriveApi.deleteFile(dialog.file.id));
      toast.success(t("dialogs.deleteSuccess"));
      setDialog(null);
      files.refresh();
      quota.refresh();
    } catch (error) {
      toast.error(t("dialogs.deleteFailed", { message: textOf(error) }));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (entry: CloudDriveTrashEntry) => {
    setRestoringId(entry.id);
    try {
      await unwrap(cloudDriveApi.restoreTrash(entry.id, { expectedMetadataRevision: entry.file.metadataRevision }));
      toast.success(t("trash.restoreSuccess", { name: entry.originalName }));
      trash.refresh();
      quota.refresh();
      files.refresh();
    } catch (error) {
      toast.error(t("trash.restoreFailed", { message: textOf(error) }));
    } finally {
      setRestoringId(null);
    }
  };

  const closeDialog = () => setDialog(null);
  const nameDialogOpen = dialog?.kind === "create" || dialog?.kind === "rename";

  return (
    <AppPage busy={files.loading || trash.loading}>
      <AppHeader
        title={t("page.title")}
        subtitle={t("page.subtitle")}
        actions={<CloudDriveQuota principal={quota.principal} loading={quota.loading} locale={locale} />}
      />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label={t("a11y.viewSwitch")} className="flex items-center gap-1 rounded-lg border p-0.5">
          <Button
            size="sm"
            variant={view === "files" ? "secondary" : "ghost"}
            aria-pressed={view === "files"}
            onClick={() => switchView("files")}
          >
            {t("views.files")}
          </Button>
          <Button
            size="sm"
            variant={view === "trash" ? "secondary" : "ghost"}
            aria-pressed={view === "trash"}
            onClick={() => switchView("trash")}
          >
            {t("views.trash")}
          </Button>
        </div>

        {view === "files" && (
          <form role="search" onSubmit={submitSearch} className="flex min-w-0 flex-1 items-center gap-2">
            <label htmlFor="cloud-drive-search" className="sr-only">
              {t("search.placeholder")}
            </label>
            <Input
              id="cloud-drive-search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t("search.placeholder")}
              aria-describedby="cloud-drive-search-hint"
              className="max-w-sm"
            />
            <p id="cloud-drive-search-hint" className="sr-only">
              {t("states.searchHint")}
            </p>
            <Button type="submit" size="sm" variant="outline">
              <Search aria-hidden />
              {t("actions.search")}
            </Button>
          </form>
        )}

        <div className="flex shrink-0 items-center gap-2">
          {view === "files" && (
            <>
              <Button size="sm" onClick={openPicker}>
                <Upload aria-hidden />
                {t("actions.upload")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "create" })}>
                <FolderPlus aria-hidden />
                {t("actions.newFolder")}
              </Button>
            </>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("actions.refresh")}
            title={t("actions.refresh")}
            disabled={view === "files" ? files.loading : trash.loading}
            onClick={() => {
              if (view === "files") {
                files.refresh();
                quota.refresh();
              } else {
                trash.refresh();
              }
            }}
          >
            <RefreshCw aria-hidden />
          </Button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        aria-label={t("a11y.selectFiles")}
        onChange={handlePicked}
      />

      {view === "files" && !searchTerm && (
        <div className="mt-3">
          <CloudDriveBreadcrumbs trail={trail} onNavigate={navigateTo} />
        </div>
      )}

      <div className="mt-4 flex-1 space-y-3">
        {view === "trash" ? (
          <CloudDriveTrashPanel
            entries={trash.entries}
            loading={trash.loading}
            error={trash.error}
            locale={locale}
            restoringId={restoringId}
            onRefresh={trash.refresh}
            onRestore={restore}
          />
        ) : searchTerm ? (
          <CloudDriveSearchPanel
            term={searchTerm}
            results={search.resultQuery === searchTerm ? search.results : undefined}
            loading={search.loading}
            error={search.error}
            openingId={openingId}
            onClear={clearSearch}
            onRetry={() => void search.run(searchTerm)}
            onOpenLocation={(hit) => void openLocation(hit.fileId)}
          />
        ) : files.error ? (
          <EmptyState
            tone="danger"
            role="alert"
            icon={<CloudOff aria-hidden />}
            title={t("states.loadFailed")}
            description={textOf(files.error)}
            action={{ label: t("actions.retry"), onClick: files.refresh }}
          />
        ) : files.items.length === 0 && !files.loading ? (
          <EmptyState
            icon={<CloudUpload aria-hidden />}
            title={t("states.emptyFolder")}
            description={t("states.emptyFolderHint")}
            action={{ label: t("actions.upload"), onClick: openPicker }}
          />
        ) : (
          <>
            <CloudDriveFileTable
              items={files.items}
              loading={files.loading}
              locale={locale}
              onOpenDirectory={openDirectory}
              onPreview={(file) => setPreviewFile(file)}
              onRename={(file) => setDialog({ kind: "rename", file })}
              onMove={(file) => setDialog({ kind: "move", file })}
              onDelete={(file) => setDialog({ kind: "delete", file })}
            />
            {files.loadMoreError && (
              <p role="alert" className="text-xs text-destructive">
                {files.loadMoreError}
              </p>
            )}
            {files.hasMore && (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={files.loadMore} disabled={files.loadingMore}>
                  {files.loadingMore && <Spinner size="xs" variant="inline" className="text-current" />}
                  {t("actions.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 上传浮层固定在右下角，不参与内容区布局；挂在内容容器之外避免出现两份。 */}
      <CloudDriveUploadPanel
        tasks={uploads.tasks}
        onRetry={uploads.retry}
        onCancel={uploads.cancel}
        onClearFinished={uploads.clearFinished}
      />

      <CloudDriveNameDialog
        open={nameDialogOpen}
        mode={dialog?.kind === "rename" ? "rename" : "create"}
        initialName={dialog?.kind === "rename" ? dialog.file.name : ""}
        loading={busy}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        onSubmit={submitName}
      />

      <CloudDriveMoveDialog
        open={dialog?.kind === "move"}
        target={dialog?.kind === "move" ? dialog.file : null}
        loading={busy}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        onConfirm={submitMove}
      />

      <CloudDriveDeleteDialog
        open={dialog?.kind === "delete"}
        targetName={dialog?.kind === "delete" ? dialog.file.name : ""}
        loading={busy}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        onConfirm={confirmDelete}
      />

      <CloudDrivePreviewDialog
        open={previewFile !== null}
        file={previewFile}
        onOpenChange={(open) => {
          if (!open) setPreviewFile(null);
        }}
      />
    </AppPage>
  );
}
