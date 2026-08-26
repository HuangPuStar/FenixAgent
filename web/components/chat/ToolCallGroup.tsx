import { ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolCallEntry } from "../../src/lib/types";
import { HindsightToolCard, isHindsightTool } from "./HindsightToolCard";
import { ToolCallRow } from "./ToolCallRow";

// =============================================================================
// 工具调用列表 — 卡片式布局，每种工具有专属视觉风格，点击弹窗查看参数
// =============================================================================

interface ToolCallGroupProps {
  entries: ToolCallEntry[];
}

const COLLAPSE_THRESHOLD = 5;

export function ToolCallGroup({ entries }: ToolCallGroupProps) {
  const { t } = useTranslation("components");
  const [collapsed, setCollapsed] = useState(entries.length > COLLAPSE_THRESHOLD);
  const wasGroupedRef = useRef(entries.length > COLLAPSE_THRESHOLD);

  // 将 hindsight 工具与普通工具分离，各自独立渲染
  const hindsightEntries = entries.filter((e) => isHindsightTool(e.toolCall.title));
  const toolEntries = entries.filter((e) => !isHindsightTool(e.toolCall.title));

  const running = toolEntries.filter((e) => e.toolCall.status === "running").length;
  const error = toolEntries.filter((e) => e.toolCall.status === "error").length;
  const complete = toolEntries.filter((e) => e.toolCall.status === "complete").length;
  const grouped = toolEntries.length > COLLAPSE_THRESHOLD;

  // 流式追加越过阈值时仅自动收起一次；用户随后手动展开不会被下一帧覆盖。
  useEffect(() => {
    if (grouped && !wasGroupedRef.current) setCollapsed(true);
    if (!grouped) setCollapsed(false);
    wasGroupedRef.current = grouped;
  }, [grouped]);

  if (entries.length === 0) return null;

  return (
    <div className="tool-call-group">
      {grouped && (
        <button
          type="button"
          className="tool-call-group-summary"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronRight className={collapsed ? undefined : "is-open"} />
          <strong>{t("toolCallGroup.count", { count: toolEntries.length })}</strong>
          <span>{t("toolCallGroup.completedCount", { count: complete })}</span>
          {error > 0 && <span className="is-error">{t("toolCallGroup.failed", { count: error })}</span>}
          {running > 0 && (
            <span className="is-running">
              <Loader2 />
              {t("toolCallGroup.runningCount", { count: running })}
            </span>
          )}
          <small>{collapsed ? t("toolCallGroup.expand") : t("toolCallGroup.collapse")}</small>
        </button>
      )}

      {toolEntries.length > 0 && !collapsed && (
        <div className="tool-call-group-list">
          {toolEntries.map((entry, i) => (
            <ToolCallRow key={entry.toolCall.id || i} tool={entry.toolCall} />
          ))}
        </div>
      )}

      {/* Hindsight 记忆工具 — 独立渲染 */}
      {hindsightEntries.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {hindsightEntries.map((entry, i) => (
            <HindsightToolCard key={entry.toolCall.id || i} tool={entry.toolCall} />
          ))}
        </div>
      )}
    </div>
  );
}
