import { useMemo } from "react";
import type { ThreadEntry, ToolCallEntry } from "../src/lib/types";
import { cn } from "../src/lib/utils";
import { PanelRightClose, PanelRight } from "lucide-react";

// =============================================================================
// ContextPanel — right-side info panel for session detail
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
      {/* Toggle button — always visible */}
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

      {/* Panel */}
      <div
        className={cn(
          "context-panel flex flex-col relative",
          collapsed && "context-panel-collapsed",
        )}
      >
        {/* Agent Info */}
        <div className="context-section">
          <div className="context-section-title">智能体信息</div>
          <ContextInfoRow label="智能体" value={displayAgentName} />
          <ContextInfoRow label="模型" value={modelName || "未知"} />
          {duration && <ContextInfoRow label="时长" value={duration} />}
        </div>

        {/* Token Ring */}
        <div className="context-section">
          <div className="context-section-title">Token 用量</div>
          <TokenRingSection
            estimatedTokens={stats.estimatedTokens}
            inputTokens={stats.estimatedInputTokens}
            outputTokens={stats.estimatedOutputTokens}
          />
        </div>

        {/* Tool Usage */}
        <div className="context-section">
          <div className="context-section-title">工具使用</div>
          <ToolUsageSection toolCounts={stats.toolCounts} total={stats.totalToolCalls} />
        </div>

        {/* Permission Queue */}
        {stats.pendingTools.length > 0 && (
          <div className="context-section">
            <div className="context-section-title">
              权限队列 ({stats.pendingTools.length})
            </div>
            {stats.pendingTools.map((tool) => (
              <PermissionQueueItem key={tool.id} title={tool.title} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function ContextInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="context-info-row">
      <span className="context-info-label">{label}</span>
      <span className="context-info-value">{value}</span>
    </div>
  );
}

function TokenRingSection({
  estimatedTokens,
  inputTokens,
  outputTokens,
}: {
  estimatedTokens: number;
  inputTokens: number;
  outputTokens: number;
}) {
  // Max token budget for ring visualization (200k default)
  const maxTokens = 200000;
  const ratio = Math.min(estimatedTokens / maxTokens, 1);
  const percent = Math.round(ratio * 100);

  // SVG ring params
  const size = 64;
  const strokeWidth = 5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);

  return (
    <div className="token-ring-container">
      <svg
        className="token-ring-svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <circle
          className="token-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
        />
        <circle
          className="token-ring-progress"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
        {/* Re-rotate text so it reads normally */}
        <g transform={`rotate(90, ${size / 2}, ${size / 2})`}>
          <text
            className="token-ring-center"
            x={size / 2}
            y={size / 2 - 2}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {percent}%
          </text>
          <text
            className="token-ring-label"
            x={size / 2}
            y={size / 2 + 10}
            textAnchor="middle"
          >
            已用
          </text>
        </g>
      </svg>
      <div className="flex-1 space-y-1">
        <TokenBreakdownRow
          color="var(--color-brand)"
          label="输入"
          value={inputTokens}
        />
        <TokenBreakdownRow
          color="#10B981"
          label="输出"
          value={outputTokens}
        />
        <TokenBreakdownRow
          color="var(--color-text-muted)"
          label="总计"
          value={estimatedTokens}
        />
      </div>
    </div>
  );
}

function TokenBreakdownRow({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <div className="token-breakdown-row">
      <span className="token-breakdown-label">
        <span className="token-breakdown-dot" style={{ background: color }} />
        {label}
      </span>
      <span className="token-breakdown-value">{formatTokenCount(value)}</span>
    </div>
  );
}

function ToolUsageSection({
  toolCounts,
  total,
}: {
  toolCounts: Record<string, number>;
  total: number;
}) {
  const entries = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  const maxCount = entries.length > 0 ? entries[0][1] : 1;

  // Color map for tool types
  const toolColors: Record<string, string> = {
    bash: "#10B981",
    edit: "#6366F1",
    read: "#22D3EE",
    write: "#6366F1",
    grep: "#F59E0B",
    glob: "#F59E0B",
    webfetch: "#F472B6",
    websearch: "#F472B6",
    task: "#6366F1",
    list: "#94A3B8",
  };

  if (total === 0) {
    return (
      <div className="text-[11px] text-text-muted py-1">暂无工具调用</div>
    );
  }

  return (
    <div>
      {entries.map(([name, count]) => (
        <div key={name} className="tool-usage-row">
          <span className="tool-usage-label">{name}</span>
          <div className="tool-usage-bar-bg">
            <div
              className="tool-usage-bar-fill"
              style={{
                width: `${(count / maxCount) * 100}%`,
                background: toolColors[name] || "#94A3B8",
              }}
            />
          </div>
          <span className="tool-usage-count">{count}</span>
        </div>
      ))}
    </div>
  );
}

function PermissionQueueItem({ title }: { title: string }) {
  return (
    <div className="permission-queue-item">
      <span className="permission-queue-dot" />
      <span className="permission-queue-text">{title}</span>
      <span className="permission-queue-pending">等待中</span>
    </div>
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

  // Count by tool type (extract base name from title)
  const toolCounts: Record<string, number> = {};
  for (const tc of toolCalls) {
    const baseName = simplifyToolName(tc.toolCall.title);
    toolCounts[baseName] = (toolCounts[baseName] || 0) + 1;
  }

  // Pending tools (waiting for confirmation)
  const pendingTools = toolCalls
    .filter((tc) => tc.toolCall.status === "waiting_for_confirmation")
    .map((tc) => ({ id: tc.toolCall.id, title: tc.toolCall.title }));

  // Token estimates from message lengths
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
    // Tool output adds to output estimate
    if (entry.type === "tool_call") {
      const rawOutput = entry.toolCall.rawOutput;
      if (rawOutput) {
        const text = JSON.stringify(rawOutput).length;
        outputChars += text;
        totalChars += text;
      }
    }
  }

  const estimatedTokens = Math.round(totalChars / 4);
  const estimatedInputTokens = Math.round(inputChars / 4);
  const estimatedOutputTokens = Math.round(outputChars / 4);

  return {
    totalToolCalls,
    toolCounts,
    pendingTools,
    estimatedTokens,
    estimatedInputTokens,
    estimatedOutputTokens,
  };
}

function simplifyDisplayName(name?: string): string {
  if (!name) return "默认";
  // env_xxx → 取前 12 字符 + …
  if (name.startsWith("env_")) return name.length > 16 ? name.slice(0, 16) + "…" : name;
  // 其他名称超过 20 字符也截断
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
