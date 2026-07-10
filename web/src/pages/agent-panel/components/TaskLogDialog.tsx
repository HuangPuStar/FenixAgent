import { useRequest } from "ahooks";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ExecutionLogInfo } from "@/src/api/tasks-v2";
import { taskV2Api } from "@/src/api/tasks-v2";
import { NS } from "@/src/i18n";

interface TaskLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  taskName: string;
  onClearLogs?: () => void;
  /** 外部触发刷新（如清空日志后） */
  refreshKey?: number;
}

/** createdAt 为 Unix 秒级时间戳，后端 toUnixTimestamp 输出 */
function formatTime(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 耗时格式化，单位语言无关，直接拼接 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function TaskLogDialog({ open, onOpenChange, taskId, taskName, onClearLogs, refreshKey }: TaskLogDialogProps) {
  const { t } = useTranslation(NS.TASKS_V2);
  const PAGE_SIZE = 20;

  const [page, setPage] = useState(1);

  const { data, loading, error, run } = useRequest(
    async (p: number) => {
      const { success, data, error } = await taskV2Api.logs(taskId, { page: p, pageSize: PAGE_SIZE });
      if (!success) throw new Error(error?.message ?? "请求失败");
      return data;
    },
    {
      defaultParams: [1],
      refreshDeps: [taskId, open, refreshKey],
      ready: !!taskId && open,
    },
  );

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  // 清空日志后重置分页
  useEffect(() => {
    setPage(1);
  }, [refreshKey]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("log.title", { name: taskName })}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <p className="text-center text-destructive py-8 text-sm">{error.message}</p>
          ) : loading ? (
            <div className="py-8">
              <Skeleton className="h-4 w-full mb-2" />
              <Skeleton className="h-4 w-3/4 mb-2" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : !data?.items?.length ? (
            <p className="text-center text-text-muted py-8 text-sm">{t("log.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t("log.time")}</TableHead>
                  <TableHead className="text-xs">{t("log.triggeredBy")}</TableHead>
                  <TableHead className="text-xs">{t("log.status")}</TableHead>
                  <TableHead className="text-xs">{t("log.duration")}</TableHead>
                  <TableHead className="text-xs">{t("log.result")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((log: ExecutionLogInfo) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-xs">{formatTime(log.createdAt)}</TableCell>
                    <TableCell>
                      <span className="text-xs text-text-muted">
                        {log.triggeredBy === "cron" ? t("triggeredBy.cron") : t("triggeredBy.manual")}
                      </span>
                    </TableCell>
                    <TableCell>
                      <LogStatusBadge status={log.status} />
                    </TableCell>
                    <TableCell className="text-xs">
                      {log.duration != null ? formatDuration(log.duration) : t("log.noResult")}
                    </TableCell>
                    <TableCell className="max-w-[200px]">
                      <div className="truncate text-xs">
                        {log.error ? (
                          <span className="text-destructive">{log.error}</span>
                        ) : log.skipReason ? (
                          <span className="text-text-muted">{log.skipReason}</span>
                        ) : (
                          log.resultSummary || t("log.noResult")
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {/* 分页 + 清空 */}
        {data && data.total > 0 && (
          <div className="flex items-center justify-between shrink-0 border-t border-border-light pt-3 mt-2">
            <span className="text-xs text-text-muted">{t("log.total", { count: data.total })}</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const p = page - 1;
                  setPage(p);
                  run(p);
                }}
                disabled={page <= 1}
              >
                {t("log.prev")}
              </Button>
              <span className="text-xs text-text-muted">
                {page}/{totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const p = page + 1;
                  setPage(p);
                  run(p);
                }}
                disabled={page >= totalPages}
              >
                {t("log.next")}
              </Button>
            </div>
            {onClearLogs && (
              <Button variant="ghost" size="sm" onClick={onClearLogs} className="text-destructive text-xs">
                {t("action.clearLogs")}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LogStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation(NS.TASKS_V2);
  const labelMap = useMemo<Record<string, string>>(
    () => ({
      success: t("status.success"),
      failed: t("status.failed"),
      timeout: t("status.timeout"),
      skipped: t("status.skipped"),
      pending: t("status.pending"),
    }),
    [t],
  );
  const variant: "default" | "destructive" | "secondary" =
    status === "success" ? "default" : status === "failed" || status === "timeout" ? "destructive" : "secondary";
  return (
    <Badge variant={variant} className="text-[11px] h-5">
      {labelMap[status] || labelMap.pending}
    </Badge>
  );
}
