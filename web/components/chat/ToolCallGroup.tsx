import { Loader2 } from "lucide-react";
import type { ToolCallEntry } from "../../src/lib/types";
import { HindsightToolCard, isHindsightTool } from "./HindsightToolCard";
import { ToolCallRow } from "./ToolCallRow";

// =============================================================================
// 工具调用列表 — 卡片式布局，每种工具有专属视觉风格，点击弹窗查看参数
// =============================================================================

interface ToolCallGroupProps {
  entries: ToolCallEntry[];
  onPermissionRespond?: (requestId: string, optionId: string | null, optionKind: string | null) => void;
}

export function ToolCallGroup({ entries, onPermissionRespond }: ToolCallGroupProps) {
  if (entries.length === 0) return null;

  // 将 hindsight 工具与普通工具分离，各自独立渲染
  const hindsightEntries = entries.filter((e) => isHindsightTool(e.toolCall.title));
  const toolEntries = entries.filter((e) => !isHindsightTool(e.toolCall.title));

  const running = toolEntries.filter((e) => e.toolCall.status === "running").length;
  const error = toolEntries.filter((e) => e.toolCall.status === "error").length;

  return (
    <div className="pl-10">
      {(running > 0 || error > 0) && (
        <div className="flex items-center gap-2 mb-1.5">
          {running > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-status-running">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              {running} 运行中
            </span>
          )}
          {error > 0 && <span className="text-[10px] text-status-error">{error} 失败</span>}
        </div>
      )}

      {/* 普通工具调用 — 卡片容器 */}
      {toolEntries.length > 0 && (
        <div className="rounded-lg border border-border bg-surface-1 overflow-hidden shadow-xs p-1.5 space-y-1.5">
          {toolEntries.map((entry, i) => (
            <ToolCallRow key={entry.toolCall.id || i} tool={entry.toolCall} onPermissionRespond={onPermissionRespond} />
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
