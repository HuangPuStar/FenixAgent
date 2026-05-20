import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Terminal,
  Bot,
  Globe,
  ShieldCheck,
  GitBranch,
  RefreshCw,
  Play,
  CheckCircle,
  XCircle,
  Loader,
  Clock,
  Eye,
  ArrowRight,
  Code,
} from "lucide-react";

const NODE_COLORS: Record<string, { main: string; light: string; headerText: string }> = {
  start: { main: "#6366f1", light: "#eef2ff", headerText: "#fff" },
  shell: { main: "#3b82f6", light: "#eff6ff", headerText: "#fff" },
  python: { main: "#0ea5e9", light: "#f0f9ff", headerText: "#fff" },
  agent: { main: "#22c55e", light: "#f0fdf4", headerText: "#fff" },
  api: { main: "#8b5cf6", light: "#f5f3ff", headerText: "#fff" },
  audit: { main: "#f59e0b", light: "#fffbeb", headerText: "#fff" },
  workflow: { main: "#ec4899", light: "#fdf2f8", headerText: "#fff" },
  loop: { main: "#06b6d4", light: "#ecfeff", headerText: "#fff" },
};

const NODE_ICONS: Record<string, React.ReactNode> = {
  start: <Play size={12} />,
  shell: <Terminal size={12} />,
  python: <Code size={12} />,
  agent: <Bot size={12} />,
  api: <Globe size={12} />,
  audit: <ShieldCheck size={12} />,
  workflow: <GitBranch size={12} />,
  loop: <RefreshCw size={12} />,
};

const NODE_LABELS: Record<string, string> = {
  start: "开始",
  shell: "Shell",
  python: "Python",
  agent: "Agent",
  api: "API",
  audit: "审批",
  workflow: "子流程",
  loop: "循环",
};

/** 运行状态样式 */
const RUN_STATUS_CFG: Record<string, { color: string; bg: string; label: string }> = {
  PENDING: { color: "#94a3b8", bg: "#f1f5f9", label: "等待中" },
  RUNNING: { color: "#3b82f6", bg: "#eff6ff", label: "运行中" },
  COMPLETED: { color: "#22c55e", bg: "#f0fdf4", label: "已完成" },
  FAILED: { color: "#ef4444", bg: "#fef2f2", label: "失败" },
  CANCELLED: { color: "#94a3b8", bg: "#f8fafc", label: "已取消" },
  SKIPPED: { color: "#d1d5db", bg: "#f9fafb", label: "已跳过" },
};

function StatusDot({ status }: { status: string }) {
  if (status === "RUNNING")
    return <Loader size={11} style={{ color: "#fff", animation: "wf-spin 1s linear infinite" }} />;
  if (status === "COMPLETED") return <CheckCircle size={11} style={{ color: "#fff" }} />;
  if (status === "FAILED") return <XCircle size={11} style={{ color: "#fff" }} />;
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: status === "PENDING" ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.3)",
        display: "inline-block",
      }}
    />
  );
}

function getPreview(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "shell":
      return String(data.command || "");
    case "python":
      return String(data.code || "");
    case "agent":
      return String(data.prompt || "");
    case "api":
      return String(data.url || "");
    case "audit": {
      const dd = data.display_data;
      if (dd && typeof dd === "object") return String((dd as Record<string, string>).message || "");
      return "";
    }
    case "workflow":
      return String(data.ref || "");
    case "loop":
      return String(data.condition || "");
    default:
      return "";
  }
}

export function WorkflowNode({ data, id, selected, type }: NodeProps) {
  const nodeType = type ?? "shell";
  const colors = NODE_COLORS[nodeType] ?? NODE_COLORS.shell;
  const label = NODE_LABELS[nodeType] ?? nodeType;
  const icon = NODE_ICONS[nodeType] ?? <Terminal size={12} />;
  const d = data as Record<string, unknown>;
  const isStart = nodeType === "start";
  const preview = getPreview(nodeType, d);

  // 运行状态
  const runStatus = d._runStatus as string | undefined;
  const exitCode = d._exitCode as number | undefined;
  const statusCfg = runStatus ? (RUN_STATUS_CFG[runStatus] ?? RUN_STATUS_CFG.PENDING) : null;

  // 回调（通过 data 注入）
  const onViewOutput = d._onViewOutput as ((nodeId: string) => void) | undefined;
  const onRerunFrom = d._onRerunFrom as ((nodeId: string) => void) | undefined;

  const isTerminal = runStatus === "COMPLETED" || runStatus === "FAILED";
  const showActions = isTerminal && !isStart;

  const borderColor = statusCfg ? statusCfg.color : selected ? colors.main : "#e5e7eb";
  const boxShadow = statusCfg
    ? `0 0 0 2px ${statusCfg.color}20`
    : selected
      ? `0 0 0 3px ${colors.main}30`
      : "0 1px 3px rgba(0,0,0,0.08)";

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 8,
        minWidth: isStart ? 120 : 180,
        maxWidth: isStart ? 140 : 240,
        fontSize: 12,
        overflow: "hidden",
        border: `2px solid ${borderColor}`,
        boxShadow,
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
    >
      {!isStart && (
        <Handle
          type="target"
          position={Position.Left}
          style={{ background: colors.main, width: 8, height: 8, border: "2px solid #fff" }}
        />
      )}

      <div
        style={{
          background: colors.main,
          color: colors.headerText,
          padding: "5px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: isStart ? "center" : undefined,
          gap: 5,
          fontWeight: 600,
          letterSpacing: 0.3,
        }}
      >
        {icon}
        <span style={{ flex: 1 }}>{label}</span>
        {statusCfg && !isStart && <StatusDot status={runStatus!} />}
      </div>

      {!isStart && (
        <div style={{ background: statusCfg?.bg ?? colors.light, padding: "6px 10px" }}>
          {d.description ? (
            <div
              style={{
                color: "#6b7280",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                fontSize: 11,
                marginBottom: preview ? 2 : 0,
              }}
            >
              {String(d.description)}
            </div>
          ) : null}
          {preview ? (
            <div
              style={{
                color: "#374151",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                fontSize: 11,
                fontFamily: "ui-monospace, monospace",
              }}
            >
              {preview.substring(0, 40)}
            </div>
          ) : !d.description ? (
            <div style={{ color: "#9ca3af", fontSize: 11, fontStyle: "italic" }}>未配置</div>
          ) : null}
        </div>
      )}

      {/* 运行状态条 + 操作按钮 */}
      {statusCfg && !isStart && (
        <div
          style={{
            padding: "3px 10px",
            background: statusCfg.bg,
            borderTop: `1px solid ${statusCfg.color}20`,
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 10,
            color: statusCfg.color,
            fontWeight: 500,
          }}
        >
          <span style={{ flex: 1 }}>{statusCfg.label}</span>
          {exitCode != null && <span>exit: {exitCode}</span>}
          {showActions && onViewOutput && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onViewOutput(id);
              }}
              title="查看输出"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                border: `1px solid ${statusCfg.color}40`,
                borderRadius: 3,
                background: "#fff",
                color: statusCfg.color,
                cursor: "pointer",
                padding: 0,
              }}
            >
              <Eye size={10} />
            </button>
          )}
          {showActions && onRerunFrom && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRerunFrom(id);
              }}
              title="从此节点重跑"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                border: `1px solid ${statusCfg.color}40`,
                borderRadius: 3,
                background: "#fff",
                color: statusCfg.color,
                cursor: "pointer",
                padding: 0,
              }}
            >
              <ArrowRight size={9} />
            </button>
          )}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        style={{ background: colors.main, width: 8, height: 8, border: "2px solid #fff" }}
      />
    </div>
  );
}

export const nodeTypes = {
  start: WorkflowNode,
  shell: WorkflowNode,
  python: WorkflowNode,
  agent: WorkflowNode,
  api: WorkflowNode,
  audit: WorkflowNode,
  workflow: WorkflowNode,
  loop: WorkflowNode,
};
