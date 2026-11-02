import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { Button } from "@fenix/ui-components/ui/button";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { ArrowUp, ChevronRight, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cloudDriveApi } from "../../api/cloud-drive";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import { cloudDriveErrorMessage } from "../../lib/errors";
import type { CloudDriveBreadcrumb, CloudDriveFile } from "../../types/cloud-drive";

interface CloudDriveMoveDialogProps {
  open: boolean;
  target: CloudDriveFile | null;
  loading?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (parentId: string | null) => void;
}

/**
 * 移动目标选择器：只列目录，逐级懒加载（进入某层才请求它的子目录）。
 *
 * 从根目录开始而不是从文件当前目录开始：移动语义是「选一个落点」，从根开始的心智模型最稳定；
 * 进入过的层级用弹窗内的面包屑表达，不写回页面状态。
 */
export function CloudDriveMoveDialog({
  open,
  target,
  loading = false,
  onOpenChange,
  onConfirm,
}: CloudDriveMoveDialogProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [trail, setTrail] = useState<CloudDriveBreadcrumb[]>([]);

  useEffect(() => {
    if (!open) return;
    setCurrentId(null);
    setTrail([]);
  }, [open]);

  const folders = useRequest(() => unwrap(cloudDriveApi.listFiles(currentId ? { parentId: currentId } : {})), {
    ready: open,
    refreshDeps: [currentId, open],
    onError: (error) => console.error("Failed to load cloud drive folders", error),
  });

  const directories = (folders.data?.items ?? []).filter((item) => item.kind === "directory");
  const unchanged = target !== null && currentId === target.parentId;

  const enter = (folder: CloudDriveFile) => {
    setCurrentId(folder.id);
    setTrail((previous) => [...previous, { id: folder.id, name: folder.name }]);
  };

  const goUp = () => {
    if (trail.length === 0) return;
    const next = trail.slice(0, -1);
    setTrail(next);
    setCurrentId(next.length === 0 ? null : (next[next.length - 1].id ?? null));
  };

  const goRoot = () => {
    setTrail([]);
    setCurrentId(null);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("dialogs.moveTitle", { name: target?.name ?? "" })}
      submitLabel={t("actions.moveHere")}
      onSubmit={() => onConfirm(currentId)}
      loading={loading}
      disabled={target === null || unchanged}
    >
      <div className="space-y-3">
        <p className="text-xs text-text-muted">{t("dialogs.moveHint")}</p>
        <div className="flex items-center gap-2">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={goUp}
            disabled={trail.length === 0}
            aria-label={t("dialogs.moveUp")}
          >
            <ArrowUp aria-hidden />
          </Button>
          <nav className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-text-muted">
            <button type="button" onClick={goRoot} className="rounded-sm px-1 hover:text-foreground">
              {t("dialogs.moveRoot")}
            </button>
            {trail.map((node, index) => (
              <span key={node.id ?? "root"} className="flex items-center gap-1">
                <ChevronRight className="size-3 text-text-dim" aria-hidden />
                <span className={index === trail.length - 1 ? "font-medium text-foreground" : undefined}>
                  {node.name}
                </span>
              </span>
            ))}
          </nav>
        </div>

        <div className="max-h-64 min-h-24 overflow-y-auto rounded-md border p-1">
          {folders.loading ? (
            <div className="flex justify-center py-6">
              <Spinner variant="inline" label={t("dialogs.loadingFolders")} />
            </div>
          ) : folders.error ? (
            <div className="space-y-2 px-3 py-4 text-center">
              <p className="text-xs text-destructive">
                {t("dialogs.foldersLoadFailed", {
                  message: cloudDriveErrorMessage(folders.error, (key) => String(t(key))),
                })}
              </p>
              <Button size="xs" variant="outline" onClick={folders.refresh}>
                {t("actions.retry")}
              </Button>
            </div>
          ) : directories.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-text-dim">{t("dialogs.foldersEmpty")}</p>
          ) : (
            <ul className="space-y-0.5">
              {directories.map((folder) => (
                <li key={folder.id}>
                  <button
                    type="button"
                    onClick={() => enter(folder)}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <Folder className="size-4 shrink-0 text-text-muted" aria-hidden />
                    <span className="truncate">{folder.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </FormDialog>
  );
}
