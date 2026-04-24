import { cn } from "../../src/lib/utils";

interface StatusBadgeProps {
  status: string;
  colorMap?: Record<string, "default" | "secondary" | "destructive" | "outline">;
}

export function getBadgeVariant(status: string): string {
  const map: Record<string, string> = {
    configured: "green",
    enabled: "green",
    "已配置": "green",
    "已启用": "green",
    unconfigured: "secondary",
    disabled: "secondary",
    "未配置": "secondary",
    "已禁用": "secondary",
    builtIn: "blue",
    "内置": "blue",
    custom: "outline",
    "自定义": "outline",
  };
  return map[status] || "outline";
}

const colorClasses: Record<string, string> = {
  green: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  secondary: "bg-secondary text-secondary-foreground",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  outline: "border border-input bg-background text-foreground",
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const variant = getBadgeVariant(status);
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium", colorClasses[variant])}>
      {status}
    </span>
  );
}
