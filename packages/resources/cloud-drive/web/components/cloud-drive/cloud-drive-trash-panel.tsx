import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { formatDateTime } from "@fenix/ui-components/lib/format";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fenix/ui-components/ui/table";
import { RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import { cloudDriveErrorMessage } from "../../lib/errors";
import { fileTypeIcon } from "../../lib/file-kind";
import type { CloudDriveTrashEntry } from "../../types/cloud-drive";

interface CloudDriveTrashPanelProps {
  entries: readonly CloudDriveTrashEntry[];
  loading: boolean;
  error: unknown;
  locale: string;
  restoringId: string | null;
  onRefresh: () => void;
  onRestore: (entry: CloudDriveTrashEntry) => void;
}

/** 回收站：删除时间、原路径与恢复入口；空态与失败态都带明确的重试路径。 */
export function CloudDriveTrashPanel({
  entries,
  loading,
  error,
  locale,
  restoringId,
  onRefresh,
  onRestore,
}: CloudDriveTrashPanelProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);

  if (loading && entries.length === 0) {
    return (
      <div className="space-y-2" role="status" aria-live="polite">
        <span className="sr-only">{t("states.loading")}</span>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        tone="danger"
        role="alert"
        icon={<Trash2 aria-hidden />}
        title={t("states.loadFailed")}
        description={cloudDriveErrorMessage(error, (key) => String(t(key)))}
        action={{ label: t("actions.retry"), onClick: onRefresh }}
      />
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<Trash2 aria-hidden />}
        title={t("states.emptyTrash")}
        description={t("states.emptyTrashHint")}
      />
    );
  }

  return (
    <Table>
      <TableCaption className="sr-only">{t("views.trash")}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t("columns.name")}</TableHead>
          <TableHead>{t("columns.originalPath")}</TableHead>
          <TableHead className="w-44">{t("columns.updatedAt")}</TableHead>
          <TableHead className="w-32 text-right">{t("columns.actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const Icon = fileTypeIcon(entry.file.kind, entry.originalName);
          return (
            <TableRow key={entry.id}>
              <TableCell className="max-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className="size-4 shrink-0 text-text-muted" aria-hidden />
                  <span className="truncate" title={entry.originalName}>
                    {entry.originalName}
                  </span>
                </div>
              </TableCell>
              <TableCell className="max-w-0">
                <span className="block truncate text-xs text-text-muted" title={entry.originalPath}>
                  {entry.originalPath}
                </span>
              </TableCell>
              <TableCell className="text-text-muted">
                {t("trash.deletedAt", { date: formatDateTime(entry.deletedAt, { locale }) })}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onRestore(entry)}
                  disabled={restoringId === entry.id}
                >
                  {restoringId === entry.id ? (
                    <Spinner size="xs" variant="inline" className="text-current" />
                  ) : (
                    <RotateCcw aria-hidden />
                  )}
                  {t("actions.restore")}
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
