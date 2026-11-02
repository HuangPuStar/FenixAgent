import { formatDateTime } from "@fenix/ui-components/lib/format";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fenix/ui-components/ui/table";
import { Download, Eye, FolderInput, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cloudDriveApi } from "../../api/cloud-drive";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import { fileTypeIcon } from "../../lib/file-kind";
import { formatBytes } from "../../lib/format";
import type { CloudDriveFile } from "../../types/cloud-drive";

interface CloudDriveFileTableProps {
  items: readonly CloudDriveFile[];
  loading: boolean;
  locale: string;
  onOpenDirectory: (file: CloudDriveFile) => void;
  onPreview: (file: CloudDriveFile) => void;
  onRename: (file: CloudDriveFile) => void;
  onMove: (file: CloudDriveFile) => void;
  onDelete: (file: CloudDriveFile) => void;
}

/** 文件表格：一行一个条目，名称列是目录的进入按钮，右侧是逐项操作。 */
export function CloudDriveFileTable({
  items,
  loading,
  locale,
  onOpenDirectory,
  onPreview,
  onRename,
  onMove,
  onDelete,
}: CloudDriveFileTableProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);

  if (loading && items.length === 0) {
    return (
      <div className="space-y-2" role="status" aria-live="polite">
        <span className="sr-only">{t("states.loading")}</span>
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  return (
    <Table>
      <TableCaption className="sr-only">{t("a11y.fileList")}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t("columns.name")}</TableHead>
          <TableHead className="w-28 text-right">{t("columns.size")}</TableHead>
          <TableHead className="w-44">{t("columns.updatedAt")}</TableHead>
          <TableHead className="w-40 text-right">{t("columns.actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((file) => {
          const Icon = fileTypeIcon(file.kind, file.name);
          return (
            <TableRow key={file.id}>
              <TableCell className="max-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className="size-4 shrink-0 text-text-muted" aria-hidden />
                  {file.kind === "directory" ? (
                    <button
                      type="button"
                      onClick={() => onOpenDirectory(file)}
                      aria-label={t("a11y.openFolder", { name: file.name })}
                      className="truncate rounded-sm text-left font-medium transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {file.name}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onPreview(file)}
                      aria-label={t("a11y.previewFile", { name: file.name })}
                      title={file.name}
                      className="truncate rounded-sm text-left transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {file.name}
                    </button>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right text-text-muted tabular-nums">
                {file.kind === "directory" ? "—" : formatBytes(file.sizeBytes, locale)}
              </TableCell>
              <TableCell className="text-text-muted">{formatDateTime(file.updatedAt, { locale })}</TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-0.5">
                  {file.kind === "file" && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onPreview(file)}
                      aria-label={t("actions.preview")}
                      title={t("actions.preview")}
                    >
                      <Eye aria-hidden />
                    </Button>
                  )}
                  {file.kind === "file" && (
                    <Button asChild variant="ghost" size="icon-sm">
                      <a
                        href={cloudDriveApi.contentUrl(file.id)}
                        aria-label={t("actions.download")}
                        title={t("actions.download")}
                      >
                        <Download aria-hidden />
                      </a>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onRename(file)}
                    aria-label={t("actions.rename")}
                    title={t("actions.rename")}
                  >
                    <Pencil aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onMove(file)}
                    aria-label={t("actions.move")}
                    title={t("actions.move")}
                  >
                    <FolderInput aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onDelete(file)}
                    aria-label={t("actions.delete")}
                    title={t("actions.delete")}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
