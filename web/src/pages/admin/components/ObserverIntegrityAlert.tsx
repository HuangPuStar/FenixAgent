// web/src/pages/admin/components/ObserverIntegrityAlert.tsx
// 一致性告警区（docs/arch/21 §5）：mismatched>0 时列出 kind+id 及可能原因；
// 全部一致时显示绿色确认文案。

import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { cn } from "../../../lib/utils";
import type { IntegrityRow } from "../utils";

interface ObserverIntegrityAlertProps {
  rows: IntegrityRow[];
  checked: number;
}

export function ObserverIntegrityAlert({ rows, checked }: ObserverIntegrityAlertProps) {
  const { t } = useTranslation("observer");
  const mismatched = rows.length;

  if (mismatched === 0) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-border bg-card px-4 py-3 text-sm">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-green-600" />
        <div>
          <p className="font-medium text-text-primary">{t("integrity.empty")}</p>
          <p className="text-xs text-text-muted">
            {t("integrity.checked")}: {checked}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm",
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium text-text-primary">
          {t("integrity.title")} — {t("integrity.mismatched")}: {mismatched}
        </p>
        <p className="text-xs text-text-muted">{t("integrity.possibleReasons")}</p>
        <ul className="grid max-h-40 gap-1 overflow-y-auto pr-1">
          {rows.map((row) => (
            <li
              key={`${row.kind}:${row.id}`}
              className="flex items-center gap-2 rounded bg-background px-2 py-1 text-xs"
            >
              <Badge variant="secondary" className="text-[10px]">
                {row.kind}
              </Badge>
              <span className="font-mono text-text-primary">{row.id}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
