import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Terminal, Bot, Globe, ShieldCheck, GitBranch, RefreshCw, Play } from "lucide-react";

const NODE_COLORS: Record<string, { main: string; light: string; headerText: string }> = {
  start: { main: "#6366f1", light: "#eef2ff", headerText: "#fff" },
  shell: { main: "#3b82f6", light: "#eff6ff", headerText: "#fff" },
  agent: { main: "#22c55e", light: "#f0fdf4", headerText: "#fff" },
  api: { main: "#8b5cf6", light: "#f5f3ff", headerText: "#fff" },
  audit: { main: "#f59e0b", light: "#fffbeb", headerText: "#fff" },
  workflow: { main: "#ec4899", light: "#fdf2f8", headerText: "#fff" },
  loop: { main: "#06b6d4", light: "#ecfeff", headerText: "#fff" },
};

const NODE_ICONS: Record<string, React.ReactNode> = {
  start: <Play size={12} />,
  shell: <Terminal size={12} />,
  agent: <Bot size={12} />,
  api: <Globe size={12} />,
  audit: <ShieldCheck size={12} />,
  workflow: <GitBranch size={12} />,
  loop: <RefreshCw size={12} />,
};

const NODE_LABELS: Record<string, string> = {
  start: "开始",
  shell: "Shell",
  agent: "Agent",
  api: "API",
  audit: "审批",
  workflow: "子流程",
  loop: "循环",
};

function getPreview(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "shell":
      return String(data.command || "");
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

export function WorkflowNode({ data, selected, type }: NodeProps) {
  const nodeType = type ?? "shell";
  const colors = NODE_COLORS[nodeType] ?? NODE_COLORS.shell;
  const label = NODE_LABELS[nodeType] ?? nodeType;
  const icon = NODE_ICONS[nodeType] ?? <Terminal size={12} />;
  const d = data as Record<string, unknown>;
  const isStart = nodeType === "start";
  const preview = getPreview(nodeType, d);

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 8,
        minWidth: isStart ? 120 : 180,
        maxWidth: isStart ? 140 : 240,
        fontSize: 12,
        overflow: "hidden",
        border: `2px solid ${selected ? colors.main : "#e5e7eb"}`,
        boxShadow: selected ? `0 0 0 3px ${colors.main}30` : "0 1px 3px rgba(0,0,0,0.08)",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
    >
      {/* 开始节点没有输入端口 */}
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
        <span>{label}</span>
      </div>

      {/* 开始节点没有预览区 */}
      {!isStart && (
        <div style={{ background: colors.light, padding: "6px 10px" }}>
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
          ) : (
            <div style={{ color: "#9ca3af", fontSize: 11, fontStyle: "italic" }}>未配置</div>
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
  agent: WorkflowNode,
  api: WorkflowNode,
  audit: WorkflowNode,
  workflow: WorkflowNode,
  loop: WorkflowNode,
};
