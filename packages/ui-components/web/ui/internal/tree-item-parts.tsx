import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";

/**
 * TreeItem 内部的展示碎片（悬浮标签、展开更多按钮）。
 *
 * 抽离自 tree.tsx（源文件超过 500 行红线）：这些片段不是公开 API，只有 TreeItem 使用，
 * 放在 internal/ 下避免污染包的对外出口。文案统一走包内命名空间 UI_COMPONENTS_NS，
 * 宿主需按 web/i18n/index.ts 的说明注册字典。
 */

// ---------------------------------------------------------------------------
// TreeLabelTip — 鼠标悬停时弹出全名浮窗，位置固定，离开消失
// ---------------------------------------------------------------------------

function TreeLabelTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex-1 min-w-0 truncate">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-xs break-all">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// ShowMoreButton (internal)
// ---------------------------------------------------------------------------

interface ShowMoreButtonProps {
  remaining: number;
  onClick: () => void;
  depth: number;
}

function ShowMoreButton({ remaining, onClick, depth }: ShowMoreButtonProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  return (
    <button
      type="button"
      className="flex items-center gap-1 h-8 pr-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-sm cursor-pointer w-full"
      style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
      onClick={onClick}
    >
      {t("tree.showMore", { count: remaining })}
    </button>
  );
}

export { ShowMoreButton, TreeLabelTip };
