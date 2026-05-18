import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  MiniMap,
  Background,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  BackgroundVariant,
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  RefreshCw,
  Square,
  Terminal,
  Bot,
  Globe,
  ShieldCheck,
  GitBranch,
  RefreshCw as LoopIcon,
  Play,
  CheckCircle,
  XCircle,
  Clock,
  Loader,
  AlertTriangle,
  Copy,
  Check,
} from "lucide-react";
import { autoLayout } from "./layout";
import {
  workflowEngineApi,
  type DAGSnapshot,
  type DAGEvent,
  type NodeOutput,
  type PendingApproval,
  type NodeStatus,
  type DAGStatus,
} from "../../api/workflow-engine";
import "./workflow.css";

// ── 状态样式配置 ──

const NODE_STATUS_CFG: Record<string, { color: string; bg: string; label: string }> = {
  PENDING: { color: "#94a3b8", bg: "#f1f5f9", label: "等待中" },
  RUNNING: { color: "#3b82f6", bg: "#eff6ff", label: "运行中" },
  COMPLETED: { color: "#22c55e", bg: "#f0fdf4", label: "已完成" },
  FAILED: { color: "#ef4444", bg: "#fef2f2", label: "失败" },
  CANCELLED: { color: "#94a3b8", bg: "#f8fafc", label: "已取消" },
  SKIPPED: { color: "#d1d5db", bg: "#f9fafb", label: "已跳过" },
};

const DAG_STATUS_CFG: Record<string, { color: string; bg: string; label: string }> = {
  PENDING: { color: "#94a3b8", bg: "#f1f5f9", label: "等待中" },
  RUNNING: { color: "#3b82f6", bg: "#eff6ff", label: "运行中" },
  SUSPENDED: { color: "#f59e0b", bg: "#fffbeb", label: "等待审批" },
  SUCCESS: { color: "#22c55e", bg: "#f0fdf4", label: "成功" },
  FAILED: { color: "#ef4444", bg: "#fef2f2", label: "失败" },
  CANCELLED: { color: "#94a3b8", bg: "#f8fafc", label: "已取消" },
  ERROR: { color: "#ef4444", bg: "#fef2f2", label: "错误" },
};

const TYPE_ICONS: Record<string, React.ReactNode> = {
  shell: <Terminal size={12} />,
  agent: <Bot size={12} />,
  api: <Globe size={12} />,
  audit: <ShieldCheck size={12} />,
  workflow: <GitBranch size={12} />,
  loop: <LoopIcon size={12} />,
};

const TYPE_COLORS: Record<string, string> = {
  shell: "#3b82f6",
  agent: "#22c55e",
  api: "#8b5cf6",
  audit: "#f59e0b",
  workflow: "#ec4899",
  loop: "#06b6d4",
};

const TYPE_LABELS: Record<string, string> = {
  shell: "Shell",
  agent: "Agent",
  api: "API",
  audit: "审批",
  workflow: "子流程",
  loop: "循环",
};

// ── React Flow 节点组件（带运行状态） ──

function RunNode({ data, selected, type }: NodeProps) {
  const d = data as Record<string, unknown>;
  const nodeType = type ?? "shell";
  const status = String(d._status ?? "PENDING") as NodeStatus;
  const statusCfg = NODE_STATUS_CFG[status] ?? NODE_STATUS_CFG.PENDING;
  const typeColor = TYPE_COLORS[nodeType] ?? "#3b82f6";
  const typeLabel = TYPE_LABELS[nodeType] ?? nodeType;
  const typeIcon = TYPE_ICONS[nodeType] ?? <Terminal size={12} />;
  const preview = String(d._preview ?? "");

  const statusIcon =
    status === "RUNNING" ? (
      <Loader size={11} style={{ animation: "spin 1s linear infinite" }} />
    ) : status === "COMPLETED" ? (
      <CheckCircle size={11} />
    ) : status === "FAILED" ? (
      <XCircle size={11} />
    ) : (
      <Clock size={11} />
    );

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 8,
        minWidth: 180,
        maxWidth: 240,
        fontSize: 12,
        overflow: "hidden",
        border: `2px solid ${selected ? statusCfg.color : "#e5e7eb"}`,
        boxShadow: selected
          ? `0 0 0 3px ${statusCfg.color}30`
          : status === "RUNNING"
            ? `0 0 0 2px ${statusCfg.color}20`
            : "0 1px 3px rgba(0,0,0,0.08)",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: typeColor, width: 8, height: 8, border: "2px solid #fff" }}
      />

      {/* 类型头 + 状态标记 */}
      <div
        style={{
          background: typeColor,
          color: "#fff",
          padding: "5px 10px",
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontWeight: 600,
          letterSpacing: 0.3,
        }}
      >
        {typeIcon}
        <span style={{ flex: 1 }}>{typeLabel}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10 }}>{statusIcon}</span>
      </div>

      {/* 预览行 + 状态背景 */}
      <div style={{ background: statusCfg.bg, padding: "6px 10px", display: "flex", alignItems: "center", gap: 6 }}>
        <div
          style={{
            flex: 1,
            color: "#374151",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontSize: 11,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {preview ? preview.substring(0, 30) : d._nodeId ?? ""}
        </div>
        <span style={{ fontSize: 9, color: statusCfg.color, fontWeight: 600, whiteSpace: "nowrap" }}>
          {statusCfg.label}
        </span>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{ background: typeColor, width: 8, height: 8, border: "2px solid #fff" }}
      />
    </div>
  );
}

const runNodeTypes = {
  shell: RunNode,
  agent: RunNode,
  api: RunNode,
  audit: RunNode,
  workflow: RunNode,
  loop: RunNode,
};

// ── 快照转 React Flow ──

interface ParsedYaml {
  nodes: Array<{ id: string; type: string; [k: string]: unknown }>;
}

function snapshotToFlow(snapshot: DAGSnapshot, yamlStr?: string) {
  // 尝试从 YAML 解析出节点类型信息
  let yamlNodes: Map<string, { type: string; preview: string }> = new Map();
  if (yamlStr) {
    try {
      // 简单解析，只提取 id/type/command/prompt/url
      const lines = yamlStr.split("\n");
      let inNode = false;
      let currentId = "";
      let currentType = "shell";
      let currentPreview = "";
      let indentLevel = 0;

      for (const line of lines) {
        const indent = line.search(/\S/);
        const trimmed = line.trim();

        if (trimmed.startsWith("- id:")) {
          // 保存上一个节点
          if (currentId) {
            yamlNodes.set(currentId, { type: currentType, preview: currentPreview });
          }
          currentId = trimmed.replace("- id:", "").trim().replace(/["']/g, "");
          currentType = "shell";
          currentPreview = "";
          inNode = true;
          indentLevel = indent;
        } else if (inNode && trimmed.startsWith("type:") && indent === indentLevel + 2) {
          currentType = trimmed.replace("type:", "").trim().replace(/["']/g, "");
        } else if (inNode && indent === indentLevel + 2) {
          if (trimmed.startsWith("command:") || trimmed.startsWith("prompt:") || trimmed.startsWith("url:")) {
            currentPreview = trimmed.split(":").slice(1).join(":").trim().replace(/["']/g, "");
          }
        }
      }
      if (currentId) {
        yamlNodes.set(currentId, { type: currentType, preview: currentPreview });
      }
    } catch {
      // YAML 解析失败，回退
    }
  }

  const nodeIds = Object.keys(snapshot.node_states);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const START = "__start__";

  // 找根节点（无入边）
  const hasIncoming = new Set<string>();
  // 无法从快照推断边，只能通过 YAML。如果没有 YAML，节点按线性排列。
  // 尝试从事件流推断拓扑（在组件中通过 events 构建）

  nodeIds.forEach((id, idx) => {
    const info = yamlNodes.get(id);
    const nodeType = info?.type ?? "shell";
    const preview = info?.preview ?? "";

    nodes.push({
      id,
      type: nodeType,
      position: { x: 240 + idx * 260, y: 100 + (idx % 3) * 100 },
      data: {
        _nodeId: id,
        _status: snapshot.node_states[id].status,
        _exitCode: snapshot.node_states[id].exit_code,
        _preview: preview,
      },
    });
  });

  return { nodes, edges };
}

// ── 主组件 ──

interface WorkflowRunDetailProps {
  runId: string;
  onBack: () => void;
}

function RunDetailInner({ runId, onBack }: WorkflowRunDetailProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();

  const [snapshot, setSnapshot] = useState<DAGSnapshot | null>(null);
  const [events, setEvents] = useState<DAGEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeOutput, setNodeOutput] = useState<NodeOutput | null>(null);
  const [outputLoading, setOutputLoading] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [rightTab, setRightTab] = useState<"events" | "output">("events");

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef(false);
  const snapshotRef = useRef<DAGSnapshot | null>(null);
  const isFirstLoad = useRef(true);

  // 保持 ref 与 state 同步
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  // ── 加载快照 ──
  const loadSnapshot = useCallback(async () => {
    try {
      const snap = await workflowEngineApi.getRunStatus(runId);
      if (abortRef.current) return;
      if (snap) {
        setSnapshot(snap);
        const flow = snapshotToFlow(snap);
        setNodes(flow.nodes);
        setEdges(flow.edges);
        // 首次加载 fitView，后续轮询不 fitView（避免画面跳动）
        if (isFirstLoad.current) {
          if (flow.nodes.length > 0) {
            setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
          }
        }
      }
    } catch (err) {
      console.error(err);
      if (isFirstLoad.current) setError((err as Error).message);
    } finally {
      if (isFirstLoad.current) {
        isFirstLoad.current = false;
        setLoading(false);
      }
    }
  }, [runId, setNodes, setEdges, fitView]);

  // ── 加载事件 ──
  const loadEvents = useCallback(async () => {
    try {
      const evts = await workflowEngineApi.getEvents(runId);
      if (abortRef.current) return;
      setEvents(Array.isArray(evts) ? evts : []);
    } catch (err) {
      console.error(err);
    }
  }, [runId]);

  // ── 加载审批列表 ──
  const loadApprovals = useCallback(async () => {
    try {
      const list = await workflowEngineApi.getPendingApprovals(runId);
      if (abortRef.current) return;
      setApprovals(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error(err);
    }
  }, [runId]);

  // 初始加载（只在 runId 变化时执行）
  useEffect(() => {
    abortRef.current = false;
    isFirstLoad.current = true;
    setLoading(true);
    setError(null);
    loadSnapshot();
    loadEvents();
    loadApprovals();
    return () => {
      abortRef.current = true;
    };
  }, [runId, loadSnapshot, loadEvents, loadApprovals]);

  // 轮询（运行中时）
  useEffect(() => {
    if (!snapshot) return;
    const isDone = ["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(snapshot.dag_status);
    if (isDone) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    pollRef.current = setInterval(() => {
      loadSnapshot();
      loadEvents();
      // 用 ref 读取最新 snapshot 避免闭包过期
      if (snapshotRef.current?.dag_status === "SUSPENDED") loadApprovals();
    }, 3000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [snapshot, loadSnapshot, loadEvents, loadApprovals]);

  // ── 选中节点 → 加载输出 ──
  useEffect(() => {
    if (!selectedNodeId) return;
    setRightTab("output");
    setOutputLoading(true);
    setNodeOutput(null);
    workflowEngineApi
      .getOutput(runId, selectedNodeId)
      .then((out) => setNodeOutput(out ?? null))
      .catch((err) => console.error(err))
      .finally(() => setOutputLoading(false));
  }, [runId, selectedNodeId]);

  // ── 自动布局 ──
  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0) return;
    const laid = autoLayout(nodes, edges);
    setNodes(laid);
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
  }, [nodes, edges, setNodes, fitView]);

  // ── 取消运行 ──
  const handleCancel = useCallback(async () => {
    try {
      await workflowEngineApi.cancel(runId);
      loadSnapshot();
    } catch (err) {
      console.error(err);
      alert((err as Error).message);
    }
  }, [runId, loadSnapshot]);

  // ── 审批通过 ──
  const handleApprove = useCallback(
    async (approval: PendingApproval) => {
      try {
        await workflowEngineApi.approve(runId, approval.nodeId, approval.approvalToken);
        loadSnapshot();
        loadApprovals();
      } catch (err) {
        console.error(err);
        alert((err as Error).message);
      }
    },
    [runId, loadSnapshot, loadApprovals],
  );

  // ── 节点选中 ──
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 8, color: "#9ca3af", fontSize: 13 }}>
        <Loader size={18} style={{ animation: "spin 1s linear infinite" }} />
        加载运行状态...
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div style={{ padding: 32 }}>
        <button type="button" onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: "#6b7280", fontSize: 12, marginBottom: 16 }}>
          <ArrowLeft size={14} /> 返回列表
        </button>
        <div style={{ textAlign: "center", padding: 40 }}>
          <AlertTriangle size={32} style={{ color: "#ef4444", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#6b7280" }}>加载失败: {error ?? "未找到运行记录"}</p>
        </div>
      </div>
    );
  }

  const dagCfg = DAG_STATUS_CFG[snapshot.dag_status] ?? DAG_STATUS_CFG.PENDING;
  const isDone = ["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(snapshot.dag_status);
  const nodeEntries = Object.entries(snapshot.node_states);
  const selectedEvents = selectedNodeId ? events.filter((e) => e.node_id === selectedNodeId) : events;

  return (
    <div className="wf-editor-container">
      {/* 返回按钮 + 状态栏 */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 16px",
          background: "#fff",
          borderBottom: "1px solid #e5e7eb",
          fontSize: 12,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{ display: "flex", alignItems: "center", gap: 3, background: "none", border: "none", cursor: "pointer", color: "#6b7280", fontSize: 12 }}
        >
          <ArrowLeft size={14} /> 返回
        </button>
        <div style={{ width: 1, height: 16, background: "#e5e7eb" }} />
        <span style={{ fontWeight: 600, color: "#111827" }}>{runId.substring(0, 20)}...</span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 99,
            fontSize: 11,
            fontWeight: 500,
            color: dagCfg.color,
            background: dagCfg.bg,
          }}
        >
          {snapshot.dag_status === "RUNNING" && (
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: dagCfg.color, animation: "wf-pulse 1.5s ease-in-out infinite" }} />
          )}
          {dagCfg.label}
        </span>
        <span style={{ color: "#9ca3af", fontSize: 11 }}>
          {nodeEntries.filter(([, s]) => s.status === "COMPLETED").length}/{nodeEntries.length} 节点
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button
            type="button"
            onClick={handleAutoLayout}
            title="自动排列"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: "none", background: "none", borderRadius: 4, color: "#6b7280", cursor: "pointer" }}
          >
            <RefreshCw size={14} />
          </button>
          {!isDone && (
            <button
              type="button"
              onClick={handleCancel}
              title="取消运行"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: "none", background: "#fef2f2", borderRadius: 4, color: "#ef4444", cursor: "pointer" }}
            >
              <Square size={13} />
            </button>
          )}
        </div>
      </div>

      {/* 画布区域 */}
      <div className="wf-canvas-wrapper" style={{ paddingTop: 44 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onNodeClick={onNodeClick}
          nodeTypes={runNodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          defaultEdgeOptions={{ type: "smoothstep", animated: true }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            position="bottom-right"
            nodeColor={(n) => {
              const d = n.data as Record<string, unknown>;
              const s = d?._status as string;
              return NODE_STATUS_CFG[s]?.color ?? "#3b82f6";
            }}
            maskColor="rgba(0,0,0,0.08)"
            style={{ borderRadius: 8 }}
          />
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#d1d5db" />
        </ReactFlow>
      </div>

      {/* 右侧面板 */}
      <aside className="wf-prop-panel">
        {/* 审批卡片（SUSPENDED 时显示） */}
        {snapshot.dag_status === "SUSPENDED" && approvals.length > 0 && (
          <div
            style={{
              padding: 12,
              borderBottom: "1px solid #fbbf24",
              background: "#fffbeb",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: "#92400e", marginBottom: 8, display: "flex", alignItems: "center", gap: 4 }}>
              <ShieldCheck size={13} /> 等待审批
            </div>
            {approvals.map((a) => (
              <div key={a.nodeId} style={{ fontSize: 11, color: "#78350f", marginBottom: 8 }}>
                <div style={{ fontWeight: 500, marginBottom: 2 }}>节点: {a.nodeId}</div>
                {a.displayData && typeof a.displayData === "object" && (
                  <div style={{ color: "#92400e", marginBottom: 4 }}>
                    {(a.displayData as Record<string, string>).message ?? ""}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => handleApprove(a)}
                  style={{
                    padding: "3px 10px",
                    border: "1px solid #f59e0b",
                    borderRadius: 4,
                    background: "#f59e0b",
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  通过
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Tab 切换 */}
        <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb" }}>
          <button
            type="button"
            onClick={() => setRightTab("events")}
            style={{
              flex: 1,
              padding: "8px 0",
              border: "none",
              background: "none",
              fontSize: 11,
              fontWeight: rightTab === "events" ? 600 : 400,
              color: rightTab === "events" ? "#111827" : "#9ca3af",
              borderBottom: rightTab === "events" ? "2px solid #3b82f6" : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            事件流 ({selectedEvents.length})
          </button>
          <button
            type="button"
            onClick={() => setRightTab("output")}
            style={{
              flex: 1,
              padding: "8px 0",
              border: "none",
              background: "none",
              fontSize: 11,
              fontWeight: rightTab === "output" ? 600 : 400,
              color: rightTab === "output" ? "#111827" : "#9ca3af",
              borderBottom: rightTab === "output" ? "2px solid #3b82f6" : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            {selectedNodeId ? `输出 (${selectedNodeId})` : "节点输出"}
          </button>
        </div>

        {/* 事件列表 */}
        {rightTab === "events" && (
          <div style={{ flex: 1, overflowY: "auto", fontSize: 11 }}>
            {selectedEvents.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "#d1d5db" }}>
                {selectedNodeId ? "该节点暂无事件" : "点击节点筛选事件"}
              </div>
            ) : (
              selectedEvents.map((evt) => (
                <div
                  key={evt.event_id}
                  style={{
                    padding: "6px 12px",
                    borderBottom: "1px solid #f3f4f6",
                    display: "flex",
                    gap: 6,
                    alignItems: "flex-start",
                    cursor: evt.node_id ? "pointer" : "default",
                  }}
                  onClick={() => {
                    if (evt.node_id) setSelectedNodeId(evt.node_id);
                  }}
                >
                  <EventIcon type={evt.type} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 1 }}>
                      <span style={{ fontWeight: 500, color: "#374151" }}>{formatEventType(evt.type)}</span>
                      <span style={{ color: "#d1d5db", fontSize: 10, flexShrink: 0 }}>
                        {new Date(evt.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                    </div>
                    {evt.node_id && (
                      <span style={{ color: "#9ca3af", fontFamily: "ui-monospace, monospace", fontSize: 10 }}>{evt.node_id}</span>
                    )}
                    {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                      <div style={{ color: "#9ca3af", fontSize: 10, marginTop: 2, fontFamily: "ui-monospace, monospace" }}>
                        {formatMeta(evt.type, evt.metadata)}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* 节点输出 */}
        {rightTab === "output" && (
          <div style={{ flex: 1, overflowY: "auto", fontSize: 11 }}>
            {!selectedNodeId ? (
              <div style={{ padding: 24, textAlign: "center", color: "#d1d5db" }}>点击节点查看输出</div>
            ) : outputLoading ? (
              <div style={{ padding: 24, textAlign: "center", color: "#9ca3af" }}>
                <Loader size={16} style={{ animation: "spin 1s linear infinite", display: "inline-block" }} />
              </div>
            ) : !nodeOutput ? (
              <div style={{ padding: 24, textAlign: "center", color: "#d1d5db" }}>暂无输出</div>
            ) : (
              <NodeOutputView output={nodeOutput} />
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

// ── 辅助组件 ──

function EventIcon({ type }: { type: string }) {
  if (type.startsWith("dag.")) {
    const isOk = type === "dag.completed";
    return isOk ? (
      <CheckCircle size={12} style={{ color: "#22c55e", flexShrink: 0, marginTop: 1 }} />
    ) : type === "dag.cancelled" ? (
      <XCircle size={12} style={{ color: "#94a3b8", flexShrink: 0, marginTop: 1 }} />
    ) : (
      <Play size={12} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 1 }} />
    );
  }
  if (type.includes("failed")) return <XCircle size={12} style={{ color: "#ef4444", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("completed")) return <CheckCircle size={12} style={{ color: "#22c55e", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("started")) return <Loader size={12} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("retrying")) return <LoopIcon size={12} style={{ color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("audit")) return <ShieldCheck size={12} style={{ color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />;
  return <Clock size={12} style={{ color: "#94a3b8", flexShrink: 0, marginTop: 1 }} />;
}

function formatEventType(type: string): string {
  const map: Record<string, string> = {
    "dag.started": "工作流启动",
    "dag.completed": "工作流完成",
    "dag.cancelled": "工作流取消",
    "node.started": "节点开始",
    "node.completed": "节点完成",
    "node.failed": "节点失败",
    "node.cancelled": "节点取消",
    "node.retrying": "节点重试",
    "node.skipped": "节点跳过",
    "sub_workflow.started": "子流程启动",
    "sub_workflow.completed": "子流程完成",
    "loop.iteration_started": "循环迭代开始",
    "loop.iteration_completed": "循环迭代完成",
    "audit.requested": "审批请求",
    "audit.approved": "审批通过",
  };
  return map[type] ?? type;
}

function formatMeta(type: string, meta: Record<string, unknown>): string {
  if (type === "node.completed") {
    const parts: string[] = [];
    if (meta.exit_code != null) parts.push(`exit=${meta.exit_code}`);
    if (meta.output_size != null) parts.push(`${meta.output_size}B`);
    if (meta.latency_ms != null) parts.push(`${Math.round(Number(meta.latency_ms))}ms`);
    return parts.join(" · ");
  }
  if (type === "node.failed") return String(meta.error ?? "");
  if (type === "node.retrying") return `第${meta.attempt}次 · ${meta.next_delay_ms}ms 后重试`;
  if (type === "node.started") {
    if (meta.pid) return `pid=${meta.pid}`;
    return "";
  }
  if (type === "dag.completed") {
    if (meta.duration_ms != null) return `${Math.round(Number(meta.duration_ms) / 1000)}s`;
    return "";
  }
  return "";
}

function NodeOutputView({ output }: { output: NodeOutput }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(output.stdout).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      {/* 状态条 */}
      <div
        style={{
          padding: "6px 12px",
          borderBottom: "1px solid #f3f4f6",
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 10,
          color: "#6b7280",
        }}
      >
        <span>exit_code: {output.exit_code}</span>
        {output.size != null && <span>· {output.size}B</span>}
        {output.ref && <span style={{ color: "#f59e0b" }}>· 大输出(ref)</span>}
        <button
          type="button"
          onClick={handleCopy}
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 3, background: "none", border: "none", cursor: "pointer", color: "#6b7280", fontSize: 10 }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "已复制" : "复制"}
        </button>
      </div>

      {/* stdout */}
      {output.stdout ? (
        <pre
          style={{
            padding: 12,
            margin: 0,
            fontSize: 11,
            lineHeight: 1.5,
            fontFamily: "ui-monospace, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            color: "#1f2937",
            background: "#fafafa",
          }}
        >
          {output.stdout}
        </pre>
      ) : (
        <div style={{ padding: 16, textAlign: "center", color: "#d1d5db" }}>无输出</div>
      )}

      {/* JSON（如果有） */}
      {output.json !== undefined && output.json !== null && (
        <div style={{ borderTop: "1px solid #f3f4f6" }}>
          <div style={{ padding: "6px 12px", fontSize: 10, color: "#6b7280", fontWeight: 500 }}>JSON 输出</div>
          <pre
            style={{
              padding: 12,
              margin: 0,
              fontSize: 11,
              lineHeight: 1.5,
              fontFamily: "ui-monospace, monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              color: "#6b7280",
            }}
          >
            {JSON.stringify(output.json, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── 导出（带 Provider） ──

export function WorkflowRunDetail(props: WorkflowRunDetailProps) {
  return (
    <ReactFlowProvider>
      <RunDetailInner {...props} />
    </ReactFlowProvider>
  );
}
