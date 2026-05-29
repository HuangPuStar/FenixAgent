import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
  ArrowRight,
  Bot,
  CheckCircle,
  Code,
  Eye,
  GitBranch,
  Globe,
  Loader,
  Play,
  RefreshCw,
  ShieldCheck,
  Terminal,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

const NODE_COLORS: Record<string, { main: string; light: string; headerText: string }> = {
  start: { main: "#6366f1", light: "rgba(99,102,241,0.08)", headerText: "#fff" },
  shell: { main: "#6366f1", light: "rgba(99,102,241,0.08)", headerText: "#fff" },
  python: { main: "#818cf8", light: "rgba(129,140,248,0.08)", headerText: "#fff" },
  agent: { main: "#10b981", light: "rgba(16,185,129,0.08)", headerText: "#fff" },
  api: { main: "#818cf8", light: "rgba(129,140,248,0.08)", headerText: "#fff" },
  audit: { main: "#f59e0b", light: "rgba(245,158,11,0.08)", headerText: "#fff" },
  workflow: { main: "#6366f1", light: "rgba(99,102,241,0.08)", headerText: "#fff" },
  loop: { main: "#818cf8", light: "rgba(129,140,248,0.08)", headerText: "#fff" },
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

const NODE_LABEL_KEYS: Record<string, string> = {
  start: "nodes.start",
  shell: "nodes.shell",
  python: "nodes.python",
  agent: "nodes.agent",
  api: "nodes.api",
  audit: "nodes.audit",
  workflow: "nodes.workflow",
  loop: "nodes.loop",
};

const RUN_STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  PENDING: { color: "#94a3b8", bg: "#f1f5f9" },
  RUNNING: { color: "#6366f1", bg: "rgba(99,102,241,0.08)" },
  COMPLETED: { color: "#10b981", bg: "rgba(16,185,129,0.08)" },
  FAILED: { color: "#ef4444", bg: "rgba(239,68,68,0.08)" },
  CANCELLED: { color: "#94a3b8", bg: "#f8fafc" },
  SKIPPED: { color: "#d1d5db", bg: "#f9fafb" },
};

const RUN_STATUS_KEYS: Record<string, string> = {
  PENDING: "nodes.status_pending",
  RUNNING: "nodes.status_running",
  COMPLETED: "nodes.status_completed",
  FAILED: "nodes.status_failed",
  CANCELLED: "nodes.status_cancelled",
  SKIPPED: "nodes.status_skipped",
};

function StatusDot({ status }: { status: string }) {
  if (status === "RUNNING") return <Loader size={11} className="text-white animate-spin" />;
  if (status === "COMPLETED") return <CheckCircle size={11} className="text-white" />;
  if (status === "FAILED") return <XCircle size={11} className="text-white" />;
  return (
    <span
      className="w-[7px] h-[7px] rounded-full inline-block"
      style={{ background: status === "PENDING" ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.3)" }}
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
  const { t } = useTranslation("workflows");
  const nodeType = type ?? "shell";
  const colors = NODE_COLORS[nodeType] ?? NODE_COLORS.shell;
  const label = t(NODE_LABEL_KEYS[nodeType] ?? nodeType);
  const icon = NODE_ICONS[nodeType] ?? <Terminal size={12} />;
  const d = data as Record<string, unknown>;
  const isStart = nodeType === "start";
  const preview = getPreview(nodeType, d);

  const runStatus = d._runStatus as string | undefined;
  const exitCode = d._exitCode as number | undefined;
  const statusColors = runStatus ? (RUN_STATUS_COLORS[runStatus] ?? RUN_STATUS_COLORS.PENDING) : null;
  const statusLabel = runStatus ? t(RUN_STATUS_KEYS[runStatus] ?? "nodes.status_pending") : null;

  const onViewOutput = d._onViewOutput as ((nodeId: string) => void) | undefined;
  const onRerunFrom = d._onRerunFrom as ((nodeId: string) => void) | undefined;

  const isTerminal = runStatus === "COMPLETED" || runStatus === "FAILED";
  const showActions = isTerminal && !isStart;

  const borderColor = statusColors ? statusColors.color : selected ? colors.main : "var(--color-border-subtle)";
  const boxShadow = statusColors
    ? `0 0 0 2px ${statusColors.color}20`
    : selected
      ? `0 0 0 3px ${colors.main}30`
      : "var(--shadow-card)";

  return (
    <div
      data-node-id={id}
      className="bg-surface-1 overflow-hidden transition-[border-color,box-shadow] duration-150"
      style={{
        borderRadius: 8,
        minWidth: isStart ? 120 : 180,
        maxWidth: isStart ? 140 : 240,
        fontSize: 12,
        border: `2px solid ${borderColor}`,
        boxShadow,
      }}
    >
      {!isStart && (
        <Handle
          type="target"
          position={Position.Top}
          className="!w-2 !h-2 !border-2 !border-white transition-transform duration-150 hover:scale-140"
          style={{ background: colors.main }}
        />
      )}

      <div
        className="flex items-center gap-1.5 font-semibold"
        style={{
          background: colors.main,
          color: colors.headerText,
          padding: "5px 10px",
          letterSpacing: 0.3,
          justifyContent: isStart ? "center" : undefined,
        }}
      >
        {icon}
        <span className="flex-1">{label}</span>
        {statusColors && !isStart && <StatusDot status={runStatus!} />}
      </div>

      {!isStart && (
        <div className="px-2.5 py-1.5" style={{ background: statusColors?.bg ?? colors.light }}>
          {d.description ? (
            <div className="text-text-secondary whitespace-nowrap overflow-hidden text-ellipsis text-[11px] mb-0.5">
              {String(d.description)}
            </div>
          ) : null}
          {preview ? (
            <div className="text-text-primary whitespace-nowrap overflow-hidden text-ellipsis text-[11px] font-mono">
              {preview.substring(0, 40)}
            </div>
          ) : !d.description ? (
            <div className="text-text-muted text-[11px] italic">{t("nodes.not_configured")}</div>
          ) : null}
        </div>
      )}

      {statusColors && !isStart && (
        <div
          className="flex items-center gap-1 text-[10px] font-medium"
          style={{
            padding: "3px 10px",
            background: statusColors.bg,
            borderTop: `1px solid ${statusColors.color}20`,
            color: statusColors.color,
          }}
        >
          <span className="flex-1">{statusLabel}</span>
          {exitCode != null && <span>exit: {exitCode}</span>}
          {showActions && onViewOutput && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onViewOutput(id);
              }}
              title={t("nodes.view_output")}
              className="flex items-center justify-center w-[18px] h-[18px] rounded-sm bg-surface-1 cursor-pointer p-0 hover:brightness-95 transition-all"
              style={{ border: `1px solid ${statusColors.color}40`, color: statusColors.color }}
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
              title={t("nodes.rerun_from")}
              className="flex items-center justify-center w-[18px] h-[18px] rounded-sm bg-surface-1 cursor-pointer p-0 hover:brightness-95 transition-all"
              style={{ border: `1px solid ${statusColors.color}40`, color: statusColors.color }}
            >
              <ArrowRight size={9} />
            </button>
          )}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2 !h-2 !border-2 !border-white transition-transform duration-150 hover:scale-140"
        style={{ background: colors.main }}
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
