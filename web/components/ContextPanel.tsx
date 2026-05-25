import { PanelRight, PanelRightClose } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadEntry, ToolCallEntry } from "../src/lib/types";
import { cn } from "../src/lib/utils";

// =============================================================================
// ContextPanel — 方案 A 紧凑流式布局
// =============================================================================

interface ContextPanelProps {
  entries: ThreadEntry[];
  agentName?: string;
  modelName?: string;
  duration?: string;
  collapsed: boolean;
  onToggle: () => void;
}

export function ContextPanel({ entries, agentName, modelName, duration, collapsed, onToggle }: ContextPanelProps) {
  const { t } = useTranslation("components");
  const stats = useMemo(() => computeStats(entries), [entries]);
  const displayAgentName = useMemo(() => simplifyDisplayName(agentName), [agentName]);

  return (
    <div className="relative flex shrink-0">
      {/* Toggle button — pinned to the left edge (divider line) */}
      <button
        className="absolute left-0 -translate-x-full top-1/2 -translate-y-1/2 z-10 w-6 h-12 flex items-center justify-center rounded-l-lg border border-border border-r-0 bg-surface-1 text-text-muted cursor-pointer transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
        onClick={onToggle}
        title={collapsed ? t("contextPanel.showContext") : t("contextPanel.hideContext")}
        aria-label={collapsed ? t("contextPanel.showContext") : t("contextPanel.hideContext")}
      >
        {collapsed ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRight className="h-3.5 w-3.5" />}
      </button>

      {/* Panel */}
      <div
        className={cn(
          "w-[280px] shrink-0 border-l border-border bg-surface-1 flex flex-col overflow-y-auto overflow-x-hidden transition-[width,opacity] duration-300 ease",
          "max-md:w-full max-md:max-h-[40vh] max-md:border-l-0 max-md:border-t max-md:border-border",
          collapsed && "!w-0 opacity-0 !border-l-0 pointer-events-none",
        )}
      >
        {/* Agent header */}
        <div
          className="px-4 py-3.5 border-b border-border"
          style={{
            background:
              "linear-gradient(135deg, color-mix(in srgb, var(--color-brand) 8%, transparent) 0%, transparent 60%)",
          }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0"
              style={{
                background: "color-mix(in srgb, var(--color-brand) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-brand) 20%, transparent)",
              }}
            >
              ⬡
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-text-primary overflow-hidden text-ellipsis whitespace-nowrap">
                {displayAgentName}
              </div>
              <div className="text-[11px] text-text-muted mt-px font-mono">{modelName || "未知"}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <span
              className="w-1.5 h-1.5 rounded-full bg-accent-green animate-[status-active-pulse_2s_ease-in-out_infinite]"
              style={{ boxShadow: "0 0 6px color-mix(in srgb, var(--color-accent-green) 40%, transparent)" }}
            />
            <span className="text-[10px] font-semibold text-accent-green uppercase tracking-[0.05em]">
              {t("contextPanel.running")}
            </span>
            {duration && <span className="text-[10px] text-text-dim ml-auto font-mono">{duration}</span>}
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 border-b border-border">
          <div className="px-3 py-2.5 text-center border-r border-border">
            <div className="text-sm font-bold font-mono text-brand">{formatTokenCount(stats.estimatedTokens)}</div>
            <div className="text-[9px] font-semibold uppercase tracking-[0.06em] text-text-muted mt-0.5">
              {t("contextPanel.tokens")}
            </div>
          </div>
          <div className="px-3 py-2.5 text-center border-r border-border">
            <div className="text-sm font-bold font-mono text-accent-green">{stats.totalToolCalls}</div>
            <div className="text-[9px] font-semibold uppercase tracking-[0.06em] text-text-muted mt-0.5">
              {t("contextPanel.tools")}
            </div>
          </div>
          <div className="px-3 py-2.5 text-center">
            <div className="text-sm font-bold font-mono text-accent-yellow">{stats.userMessages}</div>
            <div className="text-[9px] font-semibold uppercase tracking-[0.06em] text-text-muted mt-0.5">
              {t("contextPanel.messages")}
            </div>
          </div>
        </div>

        {/* Token bar */}
        <div className="px-4 py-3 border-b border-border">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[11px] font-semibold text-text-secondary">{t("contextPanel.tokenUsage")}</span>
            <span className="text-[11px] font-mono text-text-primary font-semibold">
              {formatTokenCount(stats.estimatedTokens)} / 200k
            </span>
          </div>
          <div className="h-1 rounded-sm bg-surface-3 overflow-hidden flex">
            <div
              className="h-full bg-brand transition-[width] duration-500 ease"
              style={{ width: `${Math.min(stats.estimatedInputTokens / 2000, 50)}%` }}
            />
            <div
              className="h-full bg-accent-green transition-[width] duration-500 ease"
              style={{ width: `${Math.min(stats.estimatedOutputTokens / 2000, 50)}%` }}
            />
          </div>
          <div className="flex gap-3 mt-1.5">
            <span className="text-[10px] text-text-muted flex items-center gap-1">
              <span
                className="w-[5px] h-[5px] rounded-full inline-block"
                style={{ background: "var(--color-brand)" }}
              />
              输入{" "}
              <span className="font-mono font-semibold text-text-secondary">
                {formatTokenCount(stats.estimatedInputTokens)}
              </span>
            </span>
            <span className="text-[10px] text-text-muted flex items-center gap-1">
              <span
                className="w-[5px] h-[5px] rounded-full inline-block"
                style={{ background: "var(--color-accent-green)" }}
              />
              输出{" "}
              <span className="font-mono font-semibold text-text-secondary">
                {formatTokenCount(stats.estimatedOutputTokens)}
              </span>
            </span>
          </div>
        </div>

        {/* Tool chips */}
        <div className="px-4 py-3 flex-1">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[11px] font-semibold text-text-secondary">{t("contextPanel.toolCalls")}</span>
            <span className="text-[10px] font-mono text-text-muted">{stats.totalToolCalls}</span>
          </div>
          {stats.totalToolCalls === 0 ? (
            <div className="text-[11px] text-text-muted py-1">{t("contextPanel.noToolCalls")}</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {Object.entries(stats.toolCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => (
                  <span
                    key={name}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-[3px] rounded-md text-[10px] font-mono font-medium border border-border bg-surface-2 text-text-secondary transition-all duration-150",
                      "hover:border-[color-mix(in_srgb,var(--color-brand)_25%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-brand)_6%,transparent)] hover:text-text-primary",
                      name === "bash" &&
                        "text-accent-green border-[color-mix(in_srgb,var(--color-accent-green)_15%,transparent)]",
                      name === "read" && "text-cyan border-[color-mix(in_srgb,var(--color-cyan)_15%,transparent)]",
                      (name === "edit" || name === "write") &&
                        "text-brand-light border-[color-mix(in_srgb,var(--color-brand-light)_15%,transparent)]",
                      (name === "grep" || name === "glob") &&
                        "text-accent-yellow border-[color-mix(in_srgb,var(--color-accent-yellow)_15%,transparent)]",
                      (name === "webfetch" || name === "websearch") &&
                        "text-accent-pink border-[color-mix(in_srgb,var(--color-accent-pink)_15%,transparent)]",
                    )}
                  >
                    <span
                      className={cn(
                        "w-1 h-1 rounded-full inline-block",
                        name === "bash" && "bg-accent-green",
                        name === "read" && "bg-cyan",
                        (name === "edit" || name === "write") && "bg-brand-light",
                        (name === "grep" || name === "glob") && "bg-accent-yellow",
                        (name === "webfetch" || name === "websearch") && "bg-accent-pink",
                      )}
                    />
                    {name}
                    <span className="font-bold text-text-primary">{count}</span>
                  </span>
                ))}
            </div>
          )}
        </div>

        {/* Permission queue */}
        {stats.pendingTools.length > 0 && (
          <div
            className="px-4 py-2.5 border-t border-border"
            style={{ background: "color-mix(in srgb, var(--color-accent-yellow) 6%, transparent)" }}
          >
            {stats.pendingTools.map((tool) => (
              <div key={tool.id} className="flex items-center gap-1.5 [&+&]:mt-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-yellow animate-[status-active-pulse_2s_ease-in-out_infinite] shrink-0" />
                <span className="text-[11px] text-text-primary overflow-hidden text-ellipsis whitespace-nowrap">
                  {tool.title}
                </span>
                <span className="text-[9px] font-bold text-accent-yellow uppercase ml-auto shrink-0">
                  {t("contextPanel.pendingConfirmation")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function computeStats(entries: ThreadEntry[]) {
  const toolCalls = entries.filter((e): e is ToolCallEntry => e.type === "tool_call");
  const totalToolCalls = toolCalls.length;
  const userMessages = entries.filter((e) => e.type === "user_message").length;

  const toolCounts: Record<string, number> = {};
  for (const tc of toolCalls) {
    const baseName = simplifyToolName(tc.toolCall.title);
    toolCounts[baseName] = (toolCounts[baseName] || 0) + 1;
  }

  const pendingTools = toolCalls
    .filter((tc) => tc.toolCall.status === "waiting_for_confirmation")
    .map((tc) => ({ id: tc.toolCall.id, title: tc.toolCall.title }));

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
      const rawOutput = entry.toolCall.rawOutput;
      if (rawOutput) {
        const text = JSON.stringify(rawOutput).length;
        outputChars += text;
        totalChars += text;
      }
    }
  }

  return {
    totalToolCalls,
    userMessages,
    toolCounts,
    pendingTools,
    estimatedTokens: Math.round(totalChars / 4),
    estimatedInputTokens: Math.round(inputChars / 4),
    estimatedOutputTokens: Math.round(outputChars / 4),
  };
}

function simplifyDisplayName(name?: string): string {
  if (!name) return "默认";
  if (name.startsWith("env_")) return name.length > 16 ? `${name.slice(0, 16)}…` : name;
  if (name.length > 20) return `${name.slice(0, 18)}…`;
  return name;
}

function simplifyToolName(title: string): string {
  const match = title.match(/^(\w+)/);
  return match ? match[1].toLowerCase() : title.toLowerCase();
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
