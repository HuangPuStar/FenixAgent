import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CHOICE_CHIP_CLASS } from "./chip-classes";
import { ExecutionLogTable } from "./ExecutionLogTable";

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

/**
 * 执行日志弹窗：只负责弹窗自身的壳（标题、状态筛选 chips、清空入口），
 * 取数 / 表格 / 分页 / 三态一律走 `ExecutionLogTable`（与行内日志区同一实现）。
 */
export function TaskLogDialog({ open, onOpenChange, taskId, taskName, onClearLogs, refreshKey }: TaskLogDialogProps) {
  const { t } = useTranslation(NS.TASKS_V2);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // 本组件在页面里常驻（只有 DialogContent 的子树随开关卸载），筛选状态因此不会自己复位。
  useEffect(() => {
    if (!open) setStatusFilter("all");
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

        {/* 状态过滤 chips（客户端过滤当前页，故由本组件持有筛选词并传给表格） */}
        <div className="flex items-center gap-1.5 shrink-0">
          {filterChips.map((chip) => (
            <Button
              key={chip.value}
              type="button"
              size="sm"
              variant={statusFilter === chip.value ? "default" : "outline"}
              className={CHOICE_CHIP_CLASS}
              onClick={() => setStatusFilter(chip.value)}
            >
              {chip.label}
            </Button>
          ))}
        </div>

        <ExecutionLogTable
          taskId={taskId}
          // 关闭时不取数：Radix 会卸载关闭态的 DialogContent，`ready` 是页面改用 forceMount
          // 或把弹窗内容挪到别处时的兜底，避免关掉后仍在后台空转请求。
          ready={open}
          refreshDeps={[open, refreshKey]}
          showDuration
          expandable
          filter={statusFilter === "all" ? undefined : (log) => log.status === statusFilter}
          footerExtra={
            onClearLogs && (
              <Button variant="ghost" size="sm" onClick={onClearLogs} className="text-destructive text-xs">
                {t("action.clearLogs")}
              </Button>
            )
          }
        />
      </DialogContent>
    </Dialog>
  );
}
