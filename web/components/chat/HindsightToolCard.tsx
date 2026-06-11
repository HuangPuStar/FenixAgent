import { Brain, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import type { ToolCallData } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { isHindsightTool as _isHindsightTool, formatOutput, truncate } from "./tool-call-utils";

// Re-export for backward compatibility (ToolCallGroup imports from here)
export { _isHindsightTool as isHindsightTool };

// =============================================================================
// Hindsight 工具卡片 — 记忆系统专属展示，紫色知识主题
// =============================================================================

interface HindsightToolCardProps {
  tool: ToolCallData;
}

export function HindsightToolCard({ tool }: HindsightToolCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const action = getAction(tool.title);
  const summary = getSummary(tool);
  const isRunning = tool.status === "running";
  const isError = tool.status === "error";
  const hasContent = tool.rawInput || (!isRunning && (tool.rawOutput || tool.content));

  const openDialog = useCallback(() => {
    if (hasContent) setDialogOpen(true);
  }, [hasContent]);

  return (
    <div>
      {/* 卡片主体 */}
      <div
        className={cn(
          "flex items-start gap-3 p-3 rounded-lg transition-all",
          "bg-gradient-to-r from-violet-50/60 to-indigo-50/40 dark:from-violet-950/20 dark:to-indigo-950/15",
          "border border-violet-200/50 dark:border-violet-800/30",
          hasContent && "cursor-pointer hover:from-violet-50/80 dark:hover:from-violet-950/30",
          isError && "border-status-error/40",
          isRunning && "animate-pulse",
        )}
        onClick={openDialog}
      >
        {/* Brain 图标 */}
        <div className="h-9 w-9 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center shrink-0">
          {isRunning ? (
            <Loader2 className="h-[18px] w-[18px] animate-spin text-violet-500 dark:text-violet-400" />
          ) : (
            <Brain className="h-[18px] w-[18px] text-violet-600 dark:text-violet-400" />
          )}
        </div>

        {/* 内容 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium leading-none bg-violet-100/80 dark:bg-violet-900/50 text-violet-700 dark:text-violet-300">
              {action}
            </span>
            {isError && <span className="text-[10px] text-status-error font-medium">失败</span>}
          </div>
          <div className="text-[12px] text-text-secondary mt-1.5 leading-relaxed">{summary}</div>
        </div>

        {/* 展开按钮 */}
        {hasContent && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openDialog();
            }}
            className="h-6 w-6 rounded-md flex items-center justify-center shrink-0 text-violet-400/60 hover:text-violet-500 hover:bg-violet-100/50 dark:hover:bg-violet-900/30 transition-colors mt-0.5"
          >
            <ChevronRight size={12} />
          </button>
        )}
      </div>

      {/* 详情弹窗 */}
      {hasContent && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="sm:max-w-lg p-0 gap-0">
            <DialogHeader className="px-4 py-3 border-b border-border">
              <DialogTitle className="text-sm font-medium flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
                  <Brain className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                </div>
                Hindsight · {action}
              </DialogTitle>
            </DialogHeader>
            <div className="px-4 py-3 space-y-3 max-h-[60vh] overflow-y-auto">
              {tool.rawInput && Object.keys(tool.rawInput).length > 0 && (
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-widest text-text-dim mb-1.5">Input</div>
                  <pre className="text-[11px] bg-surface-2 rounded-md px-3 py-2.5 overflow-auto font-mono text-text-secondary leading-relaxed">
                    {truncate(JSON.stringify(tool.rawInput, null, 2), 3000)}
                  </pre>
                </div>
              )}
              {!isRunning && (tool.rawOutput || tool.content) && (
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-widest text-text-dim mb-1.5">Output</div>
                  <pre
                    className={cn(
                      "text-[11px] rounded-md px-3 py-2.5 overflow-auto font-mono leading-relaxed",
                      isError ? "bg-status-error/6 text-status-error" : "bg-surface-2 text-text-secondary",
                    )}
                  >
                    {formatOutput(tool)}
                  </pre>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// =============================================================================
// 工具函数
// =============================================================================

/** 从 "hindsight_recall" 提取 "Recall" */
function getAction(title: string): string {
  const action = title.replace(/^hindsight_/, "").replace(/_/g, " ");
  return action.charAt(0).toUpperCase() + action.slice(1);
}

/** 根据 hindsight 子类型生成摘要信息 */
function getSummary(tool: ToolCallData): string {
  const action = tool.title.replace(/^hindsight_/, "").toLowerCase();

  switch (action) {
    case "recall": {
      const query = tool.rawInput?.query;
      const count = parseRecallCount(tool);
      const parts: string[] = [];
      if (query) parts.push(`"${truncate(String(query), 60)}"`);
      if (count > 0) parts.push(`${count} 条相关记忆`);
      return parts.length > 0 ? parts.join(" · ") : "搜索记忆";
    }

    case "get_bank": {
      const parsed = parseJsonOutput(tool);
      if (parsed?.name && parsed.name !== tool.title.replace(/^hindsight_/, "")) {
        return `Memory Bank · ${String(parsed.name)}`;
      }
      return "获取 Memory Bank 信息";
    }

    case "retain":
    case "sync_retain": {
      const content = tool.rawInput?.content ?? tool.rawInput?.text;
      if (typeof content === "string" && content) return truncate(content, 100);
      return "存储记忆";
    }

    case "reflect": {
      const query = tool.rawInput?.query;
      if (typeof query === "string") return `"${truncate(query, 80)}"`;
      return "深度反思分析";
    }

    case "mental_model": {
      const content = tool.rawInput?.content ?? tool.rawInput?.text;
      if (typeof content === "string") return truncate(content, 80);
      return "更新心理模型";
    }

    default:
      return action;
  }
}

/** 从 recall 输出解析结果条数 */
function parseRecallCount(tool: ToolCallData): number {
  const parsed = parseJsonOutput(tool);
  if (!parsed) return 0;
  const results = parsed.results;
  if (Array.isArray(results)) return results.length;
  return 0;
}

/** 解析工具输出的 JSON */
function parseJsonOutput(tool: ToolCallData): Record<string, unknown> | null {
  // 优先从 rawOutput.output 取（hindsight 工具的 output 在嵌套字段里）
  if (tool.rawOutput && typeof tool.rawOutput === "object") {
    const nested = (tool.rawOutput as Record<string, unknown>).output;
    if (typeof nested === "string") {
      try {
        return JSON.parse(nested);
      } catch {
        /* ignore */
      }
    }
    // rawOutput 本身可能就是结果对象
    if (typeof (tool.rawOutput as Record<string, unknown>).results === "object") {
      return tool.rawOutput as Record<string, unknown>;
    }
  }
  // 从 content 中提取
  const outputText = formatOutput(tool);
  if (!outputText) return null;
  try {
    return JSON.parse(outputText);
  } catch {
    return null;
  }
}
