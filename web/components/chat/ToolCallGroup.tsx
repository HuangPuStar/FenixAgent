import type { ToolCallEntry } from "../../src/lib/types";
import { HindsightToolCard, isHindsightTool } from "./HindsightToolCard";
import { ToolCallRow } from "./ToolCallRow";

// =============================================================================
// 工具调用列表 — 卡片式布局，每种工具有专属视觉风格，点击弹窗查看参数
// =============================================================================

interface ToolCallGroupProps {
  entries: ToolCallEntry[];
  envId?: string;
}

export function ToolCallGroup({ entries, envId }: ToolCallGroupProps) {
  // 将 hindsight 工具与普通工具分离，各自独立渲染
  const hindsightEntries = entries.filter((e) => isHindsightTool(e.toolCall.title));
  const toolEntries = entries.filter((e) => !isHindsightTool(e.toolCall.title));

  if (entries.length === 0) return null;

  return (
    <div className="tool-call-group">
      {toolEntries.length > 0 && (
        <div className="tool-call-group-list">
          {toolEntries.map((entry, i) => (
            <ToolCallRow key={entry.toolCall.id || i} tool={entry.toolCall} envId={envId} />
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
