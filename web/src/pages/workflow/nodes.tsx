import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
  Bot,
  CheckCircle,
  Code,
  GitBranch,
  Globe,
  Loader,
  Play,
  RefreshCw,
  ShieldCheck,
  Shuffle,
  Terminal,
  XCircle,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

const NODE_COLORS: Record<string, { main: string; light: string; headerText: string }> = {
  start: { main: "#1677ff", light: "rgba(22,119,255,0.08)", headerText: "#fff" },
  shell: { main: "#1677ff", light: "rgba(22,119,255,0.08)", headerText: "#fff" },
  python: { main: "#4096ff", light: "rgba(22,119,255,0.08)", headerText: "#fff" },
  agent: { main: "#10b981", light: "rgba(16,185,129,0.08)", headerText: "#fff" },
  api: { main: "#4096ff", light: "rgba(22,119,255,0.08)", headerText: "#fff" },
  audit: { main: "#f59e0b", light: "rgba(245,158,11,0.08)", headerText: "#fff" },
  workflow: { main: "#1677ff", light: "rgba(22,119,255,0.08)", headerText: "#fff" },
  loop: { main: "#4096ff", light: "rgba(22,119,255,0.08)", headerText: "#fff" },
  transform: { main: "#f97316", light: "rgba(249,115,22,0.08)", headerText: "#fff" },
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
  transform: <Shuffle size={12} />,
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
  transform: "nodes.transform",
};

const RUN_STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  PENDING: { color: "#94a3b8", bg: "#f1f5f9" },
  RUNNING: { color: "#1677ff", bg: "rgba(22,119,255,0.08)" },
  COMPLETED: { color: "#10b981", bg: "rgba(16,185,129,0.08)" },
  FAILED: { color: "#ef4444", bg: "rgba(239,68,68,0.08)" },
  CANCELLED: { color: "#94a3b8", bg: "#f8fafc" },
  SKIPPED: { color: "#d1d5db", bg: "#f9fafb" },
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

export function WorkflowNode({ data, id, selected, type }: NodeProps) {
  const { t } = useTranslation("workflows");
  const nodeType = type ?? "shell";
  const colors = NODE_COLORS[nodeType] ?? NODE_COLORS.shell;
  const label = t(NODE_LABEL_KEYS[nodeType] ?? nodeType);
  const icon = NODE_ICONS[nodeType] ?? <Terminal size={12} />;
  const d = data as Record<string, unknown>;
  const isStart = nodeType === "start";

  const runStatus = d._runStatus as string | undefined;
  const statusColors = runStatus ? (RUN_STATUS_COLORS[runStatus] ?? RUN_STATUS_COLORS.PENDING) : null;

  const borderColor = statusColors ? statusColors.color : selected ? colors.main : "var(--color-border-subtle)";
  const boxShadow = statusColors
    ? `0 0 0 2px ${statusColors.color}20`
    : selected
      ? `0 0 0 3px ${colors.main}30`
      : "var(--shadow-card)";

  // 入口：从当前节点的 inputs 字段解析
  const inputPoints = useMemo(() => {
    const inputs = d.inputs;
    if (!inputs || typeof inputs !== "object") return [];
    return Object.keys(inputs as Record<string, string>);
  }, [d.inputs]);

  // 出口：从内部注入的 _outputFields 解析
  const outputPoints = useMemo(() => {
    const fields = d._outputFields as string[] | undefined;
    return fields ?? [];
  }, [d._outputFields]);

  return (
    <div
      data-node-id={id}
      className="bg-surface-1 transition-[border-color,box-shadow] duration-150"
      style={{
        borderRadius: 8,
        minWidth: isStart ? 120 : 180,
        maxWidth: isStart ? 140 : 240,
        fontSize: 12,
        border: `2px solid ${borderColor}`,
        boxShadow,
      }}
    >
      <div
        className="flex items-center gap-1.5 font-semibold"
        style={{
          background: colors.main,
          color: colors.headerText,
          padding: "5px 10px",
          letterSpacing: 0.3,
          justifyContent: isStart ? "center" : undefined,
          borderRadius: "6px 6px 0 0",
        }}
      >
        {icon}
        <span className="flex-1">{label}</span>
        {statusColors && !isStart && <StatusDot status={runStatus!} />}
      </div>

      {/* INPUT LIST */}
      {!isStart && (
        <div
          style={{
            padding: "4px 8px",
            borderBottom: inputPoints.length > 0 ? "1px solid var(--color-border-subtle)" : undefined,
            minWidth: 160,
          }}
        >
          <div style={{ fontSize: 8, fontWeight: 700, color: "#92400e", marginBottom: 3, textTransform: "uppercase" }}>
            {t("nodes.inputs_label")}
          </div>
          {inputPoints.length === 0 ? (
            <div style={{ fontSize: 9, color: "var(--color-text-muted)", textAlign: "center", padding: "2px 0" }}>
              {t("nodes.no_inputs")}
            </div>
          ) : (
            inputPoints.map((param, i) => (
              <div
                key={param}
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "1px 0",
                  fontSize: 10,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "#f59e0b",
                    border: "2px solid #fff",
                    boxShadow: "0 0 0 1px #f59e0b",
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: "#92400e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {param}
                </span>
                <Handle
                  key={`in-${param}`}
                  type="target"
                  position={Position.Left}
                  id={`in-${param}`}
                  style={{
                    background: "#f59e0b",
                    width: 8,
                    height: 8,
                    border: "2px solid #fff",
                    top: 16,
                    left: `${-4 - i * 22}px`,
                    opacity: 0,
                  }}
                />
              </div>
            ))
          )}
        </div>
      )}

      {/* OUTPUT LIST */}
      {!isStart ? (
        <div style={{ padding: "4px 8px", minWidth: 160 }}>
          <div style={{ fontSize: 8, fontWeight: 700, color: "#166534", marginBottom: 3, textTransform: "uppercase" }}>
            {t("nodes.outputs_label")}
          </div>
          {outputPoints.length === 0 ? (
            <div style={{ fontSize: 9, color: "var(--color-text-muted)", textAlign: "center", padding: "2px 0" }}>
              {t("nodes.no_outputs")}
            </div>
          ) : (
            outputPoints.map((field, i) => (
              <div
                key={field}
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "1px 0",
                  fontSize: 10,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "#22c55e",
                    border: "2px solid #fff",
                    boxShadow: "0 0 0 1px #22c55e",
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: "#166534", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {field}
                </span>
                <Handle
                  key={`out-${field}`}
                  type="source"
                  position={Position.Right}
                  id={`out-${field}`}
                  style={{
                    background: "#22c55e",
                    width: 8,
                    height: 8,
                    border: "2px solid #fff",
                    top: 16,
                    right: `${-4 - (outputPoints.length - 1 - i) * 22}px`,
                    opacity: 0,
                  }}
                />
              </div>
            ))
          )}
        </div>
      ) : (
        /* start 节点的 outputs */
        outputPoints.map((field, i) => (
          <div
            key={field}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "1px 0",
              fontSize: 10,
              paddingLeft: 8,
              paddingRight: 8,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#22c55e",
                border: "2px solid #fff",
                boxShadow: "0 0 0 1px #22c55e",
                flexShrink: 0,
              }}
            />
            <span style={{ color: "#166534", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {field}
            </span>
            <Handle
              key={`out-${field}`}
              type="source"
              position={Position.Right}
              id={`out-${field}`}
              style={{
                background: "#22c55e",
                width: 8,
                height: 8,
                border: "2px solid #fff",
                top: 16,
                right: `${-4 - (outputPoints.length - 1 - i) * 22}px`,
                opacity: 0,
              }}
            />
          </div>
        ))
      )}

      {/* 逻辑边 target Handle — 排在数据流 Handle 后面 */}
      {!isStart && (
        <Handle
          type="target"
          position={Position.Left}
          className="!w-2 !h-2 !border-2 !border-white"
          style={{
            background: colors.main,
            top: inputPoints.length === 0 ? "50%" : `${16 + inputPoints.length * 22 - 8}px`,
            left: -4,
          }}
        />
      )}

      {/* 逻辑边 source Handle */}
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !border-2 !border-white"
        style={{
          background: colors.main,
          top: outputPoints.length === 0 ? "50%" : `${16 + outputPoints.length * 22 - 8}px`,
          right: -4,
        }}
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
  transform: WorkflowNode,
};
