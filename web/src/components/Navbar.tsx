import { cn } from "../lib/utils";

export function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    active: "bg-status-active/15 text-status-active",
    running: "bg-status-running/15 text-status-running",
    idle: "bg-status-idle/15 text-status-idle",
    inactive: "bg-text-muted/15 text-text-muted",
    requires_action: "bg-status-warning/15 text-status-warning",
    archived: "bg-text-muted/15 text-text-muted",
    error: "bg-status-error/15 text-status-error",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        colorMap[status] || "bg-surface-3 text-text-secondary",
      )}
    >
      {status}
    </span>
  );
}
