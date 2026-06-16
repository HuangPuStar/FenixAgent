import { useTranslation } from "react-i18next";
import { cn } from "../../src/lib/utils";
import { Badge } from "../ui/badge";

interface StatusBadgeProps {
  status: string;
  colorMap?: Record<string, "default" | "secondary" | "destructive" | "outline">;
}

export function getBadgeVariant(status: string): string {
  const map: Record<string, string> = {
    configured: "green",
    enabled: "green",
    unconfigured: "secondary",
    disabled: "secondary",
    builtIn: "blue",
    custom: "outline",
  };
  return map[status] || "outline";
}

const variantMap: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  green: "default",
  secondary: "secondary",
  blue: "default",
  outline: "outline",
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const { t } = useTranslation("components");
  const variant = getBadgeVariant(status);
  const badgeVariant = variantMap[variant] || "outline";
  const isActive = status === "enabled" || status === "configured";
  const label = t(`statusBadge.${status}`, status);
  return (
    <Badge
      variant={badgeVariant}
      className={cn(
        variant === "green" && "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
        variant === "blue" && "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
        isActive && "status-badge-active",
      )}
    >
      {label}
    </Badge>
  );
}
