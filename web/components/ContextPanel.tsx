import { useMemo } from "react";
import type { ThreadEntry, ToolCallEntry } from "../src/lib/types";
import { cn } from "../src/lib/utils";
import { PanelRightClose, PanelRight } from "lucide-react";

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

export function ContextPanel({
  entries,
  agentName,
  modelName,
  duration,
  collapsed,
  onToggle,
}: ContextPanelProps) {
  const stats = useMemo(() => computeStats(entries), [entries]);
  const displayAgentName = useMemo(() => simplifyDisplayName(agentName), [agentName]);

  return (
    <>
      {/* Toggle button */}
      <button
        className="context-panel-toggle"
        onClick={onToggle}
        title={collapsed ? "显示上下文面板" : "隐藏上下文面板"}
        aria-label={collapsed ? "显示上下文面板" : "隐藏上下文面板"}
      >
        {collapsed ? (
          <PanelRight className="h-3.5 w-3.5" />
        ) : (
          <PanelRightClose className="h-3.5 w-3.5" />
        )}
      </button>

      {/* Panel — 保持 context-panel / context-panel-collapsed class 兼容布局 */}
      <div
        className={cn(
          "context-panel",
          collapsed && "context-panel-collapsed",
        )}
      >
        {/* Agent header */}
        <div className="cp-header">
          <div className="cp-header-row">
            <div className="cp-avatar">⬡</div>
            <div className="cp-agent-meta">
              <div className="cp-agent-name">{displayAgentName}</div>
              <div className="cp-agent-model">{modelName || "未知"}</div>
            </div>
          </div>
          <div className="cp-status-row">
            <span className="cp-status-dot" />
            <span className="cp-status-label">Running</span>
            {duration && <span className="cp-duration">{duration}</span>}
          </div>
        </div>

        {/* Stats row */}
        <div className="cp-stats">
          <div className="cp-stat">
            <div className="cp-stat-val cp-stat-brand">{formatTokenCount(stats.estimatedTokens)}</div>
            <div className="cp-stat-label">Tokens</div>
          </div>
          <div className="cp-stat">
            <div className="cp-stat-val cp-stat-green">{stats.totalToolCalls}</div>
            <div className="cp-stat-label">Tools</div>
          </div>
          <div className="cp-stat">
            <div className="cp-stat-val cp-stat-amber">{stats.userMessages}</div>
            <div className="cp-stat-label">Messages</div>
          </div>
        </div>

        {/* Token bar */}
        <div className="cp-token">
          <div className="cp-token-header">
            <span className="cp-token-title">Token 用量</span>
            <span className="cp-token-total">
              {formatTokenCount(stats.estimatedTokens)} / 200k
            </span>
          </div>
          <div className="cp-bar-track">
            <div
              className="cp-bar-input"
              style={{ width: `${Math.min(stats.estimatedInputTokens / 2000, 50)}%` }}
            />
            <div
              className="cp-bar-output"
              style={{ width: `${Math.min(stats.estimatedOutputTokens / 2000, 50)}%` }}
            />
          </div>
          <div className="cp-token-legend">
            <span className="cp-token-legend-item">
              <span className="cp-token-dot" style={{ background: "var(--color-brand)" }} />
              输入 <span className="cp-token-val">{formatTokenCount(stats.estimatedInputTokens)}</span>
            </span>
            <span className="cp-token-legend-item">
              <span className="cp-token-dot" style={{ background: "var(--color-accent-green)" }} />
              输出 <span className="cp-token-val">{formatTokenCount(stats.estimatedOutputTokens)}</span>
            </span>
          </div>
        </div>

        {/* Tool chips */}
        <div className="cp-tools">
          <div className="cp-tools-header">
            <span className="cp-tools-title">工具调用</span>
            <span className="cp-tools-total">{stats.totalToolCalls}</span>
          </div>
          {stats.totalToolCalls === 0 ? (
            <div className="cp-tools-empty">暂无工具调用</div>
          ) : (
            <div className="cp-tools-grid">
              {Object.entries(stats.toolCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => (
                  <span key={name} className={cn("cp-tool-chip", name)}>
                    <span className="cp-tool-chip-dot" />
                    {name}
                    <span className="cp-tool-chip-count">{count}</span>
                  </span>
                ))}
            </div>
          )}
        </div>

        {/* Permission queue */}
        {stats.pendingTools.length > 0 && (
          <div className="cp-perm">
            {stats.pendingTools.map((tool) => (
              <div key={tool.id} className="cp-perm-row">
                <span className="cp-perm-dot" />
                <span className="cp-perm-text">{tool.title}</span>
                <span className="cp-perm-badge">待确认</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function computeStats(entries: ThreadEntry[]) {
  const toolCalls = entries.filter(
    (e): e is ToolCallEntry => e.type === "tool_call",
  );
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
      const text = entry.chunks.reduce(
        (sum, c) => sum + (c.text?.length || 0),
        0,
      );
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
  if (name.startsWith("env_")) return name.length > 16 ? name.slice(0, 16) + "…" : name;
  if (name.length > 20) return name.slice(0, 18) + "…";
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
