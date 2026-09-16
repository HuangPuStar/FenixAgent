import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
  Bot,
  Boxes,
  CheckCircle,
  Code,
  Flag,
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

/**
 * 工具颜色缓存 — 模块级 Map，前端加载 custom tools 后填充。
 * WorkflowNode 渲染 custom 节点时按 tool 名查表，未命中回退 NODE_COLORS.custom 默认色。
 */
const toolColorCache = new Map<string, string>();

/** 供 WorkflowEditor 在加载 customTools 后调用，批量注册工具颜色 */
export function setToolColors(tools: Array<{ name: string; color?: string }>) {
  for (const t of tools) {
    if (t.color) toolColorCache.set(t.name, t.color);
  }
}

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
  // 自定义节点（SlurmNode 等用户工具）：紫色突出区别于内置类型
  custom: { main: "#8b5cf6", light: "rgba(139,92,246,0.08)", headerText: "#fff" },
  end: { main: "#22c55e", light: "rgba(34,197,94,0.08)", headerText: "#fff" },
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
  // Boxes 表达"工具集合"语义（对应 WORKFLOW_TOOLS_DIR 注册的 CustomNode 工具）
  custom: <Boxes size={12} />,
  end: <Flag size={12} />,
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
  custom: "nodes.custom",
  end: "nodes.end",
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
  const d = data as Record<string, unknown>;
  const isStart = nodeType === "start";

  // custom 节点按 tool 名查工具专属色（来自 CustomNode.color 字段）
  // 未命中或非 custom 节点回退 NODE_COLORS 默认色
  const toolName = typeof d.tool === "string" ? d.tool.trim() : "";
  const toolColor = nodeType === "custom" && toolName ? toolColorCache.get(toolName) : undefined;
  const baseColors = NODE_COLORS[nodeType] ?? NODE_COLORS.shell;
  const colors = toolColor ? { ...baseColors, main: toolColor } : baseColors;

  const label = t(NODE_LABEL_KEYS[nodeType] ?? nodeType);
  const icon = NODE_ICONS[nodeType] ?? <Terminal size={12} />;

  const runStatus = d._runStatus as string | undefined;
  const statusColors = runStatus ? (RUN_STATUS_COLORS[runStatus] ?? RUN_STATUS_COLORS.PENDING) : null;

  // 节点主标题文本：优先展示用户填写的 description，没填则回退到节点 id（如 shell_1），
  // 作为节点头部主标题；类型名（label）降级为副标题。
  const description = typeof d.description === "string" ? d.description.trim() : "";
  // 优先级：description > tool 名（仅 custom）> id
  // 让 custom 节点没填 description 时至少能看到 tool 名（如 "trim_galore"），
  // 而不是冷冰冰的 "custom_2"。其他类型不受影响。
  const nodeSubtitle = isStart ? "" : description || (nodeType === "custom" && toolName ? toolName : id);

  const isRunning = runStatus === "RUNNING";

  const borderColor = statusColors ? statusColors.color : selected ? colors.main : "var(--color-border-subtle)";
  // RUNNING 状态加强光环（3px 30% 透明度），其他状态维持原有 2px 20% 的描边强度
  const boxShadow = statusColors
    ? `0 0 0 ${isRunning ? 3 : 2}px ${statusColors.color}${isRunning ? "30" : "20"}`
    : selected
      ? `0 0 0 3px ${colors.main}30`
      : "var(--shadow-card)";

  // 入口：从当前节点的 inputs 字段解析
  const inputPoints = useMemo(() => {
    const inputs = d.inputs;
    if (!inputs || typeof inputs !== "object") return [];
    return Object.keys(inputs as Record<string, string>);
  }, [d.inputs]);

  // 出口：合并两源（之前只读 _outputFields，导致下游用 ${{ params.x }} 而非 nodes.X.output.Y 引用时，
  // 节点卡片右侧完全不显示产物端口，用户看不到节点声明了哪些 outputs）
  // 1. yaml 中声明的 outputs 字段 key（custom 节点产物声明，结构 { 字段名: { pattern, type } }）
  // 2. transform 节点的单数 output 字段（结构 { 字段名: 表达式 }）
  // 3. _outputFields（yaml-utils 根据"下游 inputs 引用 nodes.X.output.Y"反向推断注入，
  //    仅用于在节点上画出 dataFlow 连线的 source handle，未必覆盖全部声明字段）
  // 取并集去重，声明在前。
  const outputPoints = useMemo(() => {
    const declaredKeys: string[] = [];
    if (d.outputs && typeof d.outputs === "object") {
      declaredKeys.push(...Object.keys(d.outputs as Record<string, unknown>));
    }
    if (d.output && typeof d.output === "object") {
      declaredKeys.push(...Object.keys(d.output as Record<string, unknown>));
    }
    const inferred = (d._outputFields as string[] | undefined) ?? [];
    return [...new Set([...declaredKeys, ...inferred])];
  }, [d.outputs, d.output, d._outputFields]);

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
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            {/* 主标题：节点具体名称（description 优先，回退到节点 id） */}
            <span className="truncate">{nodeSubtitle || label}</span>
          </div>
          {/* 副标题：节点类型（如 Shell / Python），让用户快速区分节点种类 */}
          {!isStart && nodeSubtitle && (
            <div
              className="font-normal truncate"
              style={{ fontSize: 10, opacity: 0.78, lineHeight: "12px", marginTop: 1 }}
              title={label}
            >
              {label}
            </div>
          )}
        </div>
        {statusColors && !isStart && <StatusDot status={runStatus!} />}
      </div>

      {/* INPUT LIST */}
      {!isStart && (
        <div
          // 左 padding 收到 4px，让每行的 target Handle 凸出 item div 左边缘 4px 后正好骑在节点左边缘上
          style={{
            padding: "4px 8px 4px 4px",
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
            inputPoints.map((param) => (
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
                {/* Input Handle 直接作为可见圆点：position=Left 让 React Flow 自动把它对齐到 item div 左边缘外，
                    top=50% 让它在行内垂直居中。Handle 的 DOM 位置 = 用户看到的圆点 = 连线端点，三者一致，连线不再漂移。 */}
                <Handle
                  key={`in-${param}`}
                  type="target"
                  position={Position.Left}
                  id={`in-${param}`}
                  style={{
                    background: "#f59e0b",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: "2px solid #fff",
                    boxShadow: "0 0 0 1px #f59e0b",
                    top: "50%",
                  }}
                />
                <span style={{ color: "#92400e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {param}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {/* OUTPUT LIST */}
      {!isStart ? (
        // 右 padding 收到 4px，让每行的 source Handle 凸出 item div 右边缘 4px 后正好骑在节点右边缘上
        <div style={{ padding: "4px 4px 4px 8px", minWidth: 160 }}>
          <div style={{ fontSize: 8, fontWeight: 700, color: "#166534", marginBottom: 3, textTransform: "uppercase" }}>
            {t("nodes.outputs_label")}
          </div>
          {outputPoints.length === 0 ? (
            <div style={{ fontSize: 9, color: "var(--color-text-muted)", textAlign: "center", padding: "2px 0" }}>
              {t("nodes.no_outputs")}
            </div>
          ) : (
            outputPoints.map((field) => (
              <div
                key={field}
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                  padding: "1px 0",
                  fontSize: 10,
                }}
              >
                <span style={{ color: "#166534", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {field}
                </span>
                {/* Output Handle 直接作为可见圆点：position=Right 让 React Flow 自动对齐到节点右边缘，
                    top=50% 让它在行内垂直居中，与 input 行的 Handle 同样保证 DOM 位置 = 圆点 = 连线端点。 */}
                <Handle
                  key={`out-${field}`}
                  type="source"
                  position={Position.Right}
                  id={`out-${field}`}
                  style={{
                    background: "#22c55e",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: "2px solid #fff",
                    boxShadow: "0 0 0 1px #22c55e",
                    top: "50%",
                  }}
                />
              </div>
            ))
          )}
        </div>
      ) : (
        /* start 节点的 outputs */
        outputPoints.map((field) => (
          <div
            key={field}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              padding: "1px 8px",
              fontSize: 10,
            }}
          >
            <span style={{ color: "#166534", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {field}
            </span>
            {/* Start 节点的 output Handle 同样直接作为可见圆点，position=Right 自动对齐节点右边缘 */}
            <Handle
              key={`out-${field}`}
              type="source"
              position={Position.Right}
              id={`out-${field}`}
              style={{
                background: "#22c55e",
                width: 8,
                height: 8,
                borderRadius: "50%",
                border: "2px solid #fff",
                boxShadow: "0 0 0 1px #22c55e",
                top: "50%",
              }}
            />
          </div>
        ))
      )}

      {/* STATUS BAR — 运行状态下显示状态条，让 RUNNING/COMPLETED/FAILED 等状态一目了然 */}
      {runStatus && !isStart && (
        <div
          style={{
            background: statusColors!.bg,
            color: statusColors!.color,
            padding: "3px 10px",
            fontSize: 10,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 4,
            borderRadius: "0 0 6px 6px",
          }}
        >
          {isRunning && <Loader size={10} className="animate-spin" />}
          {runStatus === "COMPLETED" && <CheckCircle size={10} />}
          {runStatus === "FAILED" && <XCircle size={10} />}
          <span className="truncate">
            {t(`nodes.status_${runStatus.toLowerCase()}`)}
            {/* FAILED 状态追加 exit code，方便快速定位错误 */}
            {runStatus === "FAILED" && d._exitCode != null ? ` (exit ${String(d._exitCode)})` : ""}
          </span>
        </div>
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
  // 自定义节点：复用 WorkflowNode 渲染外壳，type === "custom" 时颜色/图标走 NODE_COLORS.custom
  // 没有 custom 注册项时，ReactFlow 对未知 type 渲染空元素，导致用户看到"白框"——这是核心 bug 根因
  custom: WorkflowNode,
  end: WorkflowNode,
};
