import { useMemo } from "react";
import type { ThreadEntry, ToolCallEntry } from "../../lib/types";

interface StatusHeaderProps {
  agentName?: string;
  modelName?: string;
  entries?: ThreadEntry[];
}

export function StatusHeader({ agentName, modelName, entries = [] }: StatusHeaderProps) {
  const stats = useMemo(() => computeStats(entries), [entries]);
  const displayName = useMemo(() => {
    if (!agentName) return "\u2014";
    return agentName;
  }, [agentName]);

  const _tokenPercent = stats.estimatedTokens > 0 ? Math.min((stats.estimatedTokens / 200000) * 100, 100) : 0;
  const inputPercent = stats.estimatedInputTokens > 0 ? (stats.estimatedInputTokens / 200000) * 100 : 0;
  const outputPercent = stats.estimatedOutputTokens > 0 ? (stats.estimatedOutputTokens / 200000) * 100 : 0;

  return (
    <div
      className="px-4 py-3 border-b border-border flex items-center gap-3 shrink-0"
      style={{
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--color-brand) 5%, transparent) 0%, transparent 60%)",
      }}
    >
      {/* 智能体头像 */}
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center text-base shrink-0"
        style={{
          background: "color-mix(in srgb, var(--color-brand) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-brand) 18%, transparent)",
        }}
      >
        ⬡
      </div>

      {/* 名称 + 模型 */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-text-primary truncate leading-tight">{displayName}</div>
        <div className="text-[12px] text-text-muted truncate mt-0.5">
          {modelName || "\u2014"}
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-accent-green ml-1.5 align-middle animate-[status-active-pulse_2s_ease-in-out_infinite]"
            style={{ boxShadow: "0 0 4px color-mix(in srgb, var(--color-accent-green) 40%, transparent)" }}
          />
        </div>
      </div>

      {/* Token 统计 */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="font-mono text-xs font-medium text-text-secondary">
          {formatTokenCount(stats.estimatedTokens)}/200k
        </span>
        <div className="w-20 h-1.5 rounded-full bg-surface-3 overflow-hidden flex">
          <div
            className="h-full bg-brand transition-[width] duration-500 ease rounded-full"
            style={{ width: `${inputPercent}%` }}
          />
          <div
            className="h-full bg-accent-green transition-[width] duration-500 ease rounded-full"
            style={{ width: `${outputPercent}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function computeStats(entries: ThreadEntry[]) {
  let totalChars = 0;
  let inputChars = 0;
  let outputChars = 0;

  for (const entry of entries) {
    if (entry.type === "assistant_message") {
      const text = entry.chunks.reduce((sum, c) => sum + (c.text?.length || 0), 0);
      outputChars += text;
      totalChars += text;
    }
    if (entry.type === "user_message") {
      const text = entry.content?.length || 0;
      inputChars += text;
      totalChars += text;
    }
    if (entry.type === "tool_call") {
      const rawOutput = (entry as ToolCallEntry).toolCall.rawOutput;
      if (rawOutput) {
        const text = JSON.stringify(rawOutput).length;
        outputChars += text;
        totalChars += text;
      }
    }
  }

  return {
    estimatedTokens: Math.round(totalChars / 4),
    estimatedInputTokens: Math.round(inputChars / 4),
    estimatedOutputTokens: Math.round(outputChars / 4),
  };
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
