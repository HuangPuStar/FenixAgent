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
    if (agentName.startsWith("env_")) return agentName.length > 14 ? `${agentName.slice(0, 14)}\u2026` : agentName;
    if (agentName.length > 18) return `${agentName.slice(0, 16)}\u2026`;
    return agentName;
  }, [agentName]);

  const _tokenPercent = stats.estimatedTokens > 0 ? Math.min((stats.estimatedTokens / 200000) * 100, 100) : 0;
  const inputPercent = stats.estimatedInputTokens > 0 ? (stats.estimatedInputTokens / 200000) * 100 : 0;
  const outputPercent = stats.estimatedOutputTokens > 0 ? (stats.estimatedOutputTokens / 200000) * 100 : 0;

  return (
    <div
      className="px-3 py-2 border-b border-border flex items-center gap-2 text-[11px] shrink-0"
      style={{
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--color-brand) 5%, transparent) 0%, transparent 60%)",
      }}
    >
      <div
        className="w-5 h-5 rounded flex items-center justify-center text-[10px] shrink-0"
        style={{
          background: "color-mix(in srgb, var(--color-brand) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-brand) 18%, transparent)",
        }}
      >
        ⬡
      </div>

      <span className="font-semibold text-text-primary truncate max-w-[100px]">{displayName}</span>
      <span className="text-text-muted truncate max-w-[80px] font-mono">{modelName || "\u2014"}</span>

      <span
        className="w-1.5 h-1.5 rounded-full bg-accent-green animate-[status-active-pulse_2s_ease-in-out_infinite] shrink-0"
        style={{ boxShadow: "0 0 4px color-mix(in srgb, var(--color-accent-green) 40%, transparent)" }}
      />

      <span className="font-mono font-semibold text-text-secondary ml-auto shrink-0">
        {formatTokenCount(stats.estimatedTokens)}/200k
      </span>
      <div className="w-16 h-1 rounded-sm bg-surface-3 overflow-hidden flex shrink-0">
        <div className="h-full bg-brand transition-[width] duration-500 ease" style={{ width: `${inputPercent}%` }} />
        <div
          className="h-full bg-accent-green transition-[width] duration-500 ease"
          style={{ width: `${outputPercent}%` }}
        />
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
