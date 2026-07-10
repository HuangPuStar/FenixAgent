import { useRequest } from "ahooks";
import { ChevronDown, ChevronUp } from "lucide-react";
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

type StatusFilter = "all" | "success" | "failed" | "timeout" | "skipped";

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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  // 前端本地过滤
  const filteredItems = useMemo(() => {
    const items = data?.items ?? [];
    if (statusFilter === "all") return items;
    return items.filter((log: ExecutionLogInfo) => log.status === statusFilter);
  }, [data?.items, statusFilter]);

  // 关闭时重置过滤和展开状态
  useEffect(() => {
    if (!open) {
      setStatusFilter("all");
      setExpandedId(null);
    }
  }, [open]);

  const filterChips: { value: StatusFilter; label: string }[] = [
    { value: "all", label: t("filter.all") },
    { value: "success", label: t("status.success") },
    { value: "failed", label: t("status.failed") },
    { value: "timeout", label: t("status.timeout") },
    { value: "skipped", label: t("status.skipped") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("log.title", { name: taskName })}</DialogTitle>
        </DialogHeader>

        {/* 状态过滤 chips */}
        <div className="flex items-center gap-1.5 shrink-0">
          {filterChips.map((chip) => (
            <Button
              key={chip.value}
              type="button"
              size="sm"
              variant={statusFilter === chip.value ? "default" : "outline"}
              className="rounded-full h-6 px-3 text-xs font-normal"
              onClick={() => setStatusFilter(chip.value)}
            >
              {chip.label}
            </Button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <p className="text-center text-destructive py-8 text-sm">{error.message}</p>
          ) : loading ? (
            <div className="py-8">
              <Skeleton className="h-4 w-full mb-2" />
              <Skeleton className="h-4 w-3/4 mb-2" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : !filteredItems.length ? (
            <p className="text-center text-text-muted py-8 text-sm">{t("log.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-6" />
                  <TableHead className="text-xs">{t("log.time")}</TableHead>
                  <TableHead className="text-xs">{t("log.triggeredBy")}</TableHead>
                  <TableHead className="text-xs">{t("log.status")}</TableHead>
                  <TableHead className="text-xs">{t("log.duration")}</TableHead>
                  <TableHead className="text-xs">{t("log.result")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((log: ExecutionLogInfo) => {
                  const isExpanded = expandedId === log.id;
                  const hasDetail = !!(log.error || log.resultSummary || log.skipReason);
                  return (
                    <LogRow
                      key={log.id}
                      log={log}
                      t={t}
                      isExpanded={isExpanded}
                      hasDetail={hasDetail}
                      onToggle={() => setExpandedId(isExpanded ? null : log.id)}
                    />
                  );
                })}
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

/** 可展开的日志行 */
function LogRow({
  log,
  t,
  isExpanded,
  hasDetail,
  onToggle,
}: {
  log: ExecutionLogInfo;
  t: (key: string, opts?: Record<string, unknown>) => string;
  isExpanded: boolean;
  hasDetail: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow
        className={`cursor-pointer ${isExpanded ? "bg-muted/30" : ""}`}
        onClick={hasDetail ? onToggle : undefined}
      >
        <TableCell className="w-6 pr-0">
          {hasDetail && (
            <span className="text-text-muted">
              {isExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </span>
          )}
        </TableCell>
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
      {/* 展开详情 */}
      {isExpanded && hasDetail && (
        <TableRow className="bg-muted/20">
          <TableCell colSpan={6} className="px-4 py-3">
            <div className="space-y-1.5">
              {log.error && (
                <div>
                  <span className="text-xs font-medium text-destructive">{t("log.errorLabel")}: </span>
                  <pre className="mt-0.5 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
                    {log.error}
                  </pre>
                </div>
              )}
              {log.resultSummary && (
                <div>
                  <span className="text-xs font-medium text-emerald-600">{t("log.resultLabel")}: </span>
                  <pre className="mt-0.5 text-xs font-mono text-text-primary whitespace-pre-wrap break-all">
                    {log.resultSummary}
                  </pre>
                </div>
              )}
              {log.skipReason && (
                <div>
                  <span className="text-xs font-medium text-text-muted">{t("log.skipLabel")}: </span>
                  <span className="text-xs text-text-muted">{log.skipReason}</span>
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
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
