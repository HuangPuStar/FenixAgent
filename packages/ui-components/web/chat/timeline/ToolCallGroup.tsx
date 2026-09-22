/**
 * 工具调用列表 — 卡片式布局，每种工具有专属视觉风格，点击弹窗查看参数。
 *
 * 来源：`packages/agent-runtime/web/components/chat/ToolCallGroup.tsx` 逐字复制。
 * 纯化改动点：`envId` prop 替换为宿主注入的 `onPreviewFile` 回调（透传给 ToolCallRow），
 * `HindsightToolCard` / `ToolCallRow` 改从同目录导入。
 */

import { isHindsightTool } from "../lib/tool-call-utils";
import type { ToolCallEntry } from "../types";
import { HindsightToolCard } from "./HindsightToolCard";
import { ToolCallRow } from "./ToolCallRow";

// =============================================================================
// 工具调用列表 — 卡片式布局，每种工具有专属视觉风格，点击弹窗查看参数
// =============================================================================

interface ToolCallGroupProps {
  entries: ToolCallEntry[];
  /** 宿主注入的文件预览回调，透传给每张工具卡片；缺省时不渲染文件链接。 */
  onPreviewFile?: (path: string) => void;
  /** 是否位于活动链内，透传给每行（见 `ToolCallRow` 的 `inActivityChain`）。 */
  inActivityChain?: boolean;
}

/** 工具调用分组：hindsight 记忆工具与普通工具分开渲染。复制自 `packages/agent-runtime/web/components/chat/ToolCallGroup.tsx`。 */
export function ToolCallGroup({ entries, onPreviewFile, inActivityChain }: ToolCallGroupProps) {
  // 将 hindsight 工具与普通工具分离，各自独立渲染
  const hindsightEntries = entries.filter((e) => isHindsightTool(e.toolCall.title));
  const toolEntries = entries.filter((e) => !isHindsightTool(e.toolCall.title));

  if (entries.length === 0) return null;

  return (
    <div className="relative mx-0 mt-[2px] mb-1" data-slot="chat-tool-group">
      {toolEntries.length > 0 && (
        <div className="grid gap-px">
          {toolEntries.map((entry, i) => (
            <ToolCallRow
              key={entry.toolCall.id || i}
              tool={entry.toolCall}
              onPreviewFile={onPreviewFile}
              inActivityChain={inActivityChain}
            />
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
