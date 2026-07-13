import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

interface ProdViewShellProps {
  title?: string;
  children: ReactNode;
}

/** ProdView 轻量布局壳：极简 header + 全屏 chat 区域 */
export function ProdViewShell({ title, children }: ProdViewShellProps) {
  const { t } = useTranslation(NS.PROD_VIEWS);

  return (
    <div className="flex h-screen flex-col bg-[#f8fafc]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 text-sm">
        <span className="font-medium text-gray-700">{title ?? t("modules.chatHeader")}</span>
        <span className="text-xs text-gray-400">FenixAgent</span>
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
