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
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type OnSelectionChangeFunc,
  BackgroundVariant,
  Panel,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  FilePlus,
  Upload,
  Download,
  LayoutGrid,
  Code,
  X,
  Terminal,
  Bot,
  Globe,
  ShieldCheck,
  GitBranch,
  RefreshCw,
  Eye,
  Edit3,
  Lock,
  Play,
  CheckCircle,
  AlertTriangle,
  List,
  Save,
  Rocket,
  Square,
  Clock,
  Loader,
  XCircle,
  Copy,
  Check,
} from "lucide-react";
import { nodeTypes } from "./nodes";
import { autoLayout } from "./layout";
import {
  yamlToFlow,
  flowToYaml,
  nextNodeId,
  resetNodeCounter,
  defaultMeta,
  createStartNode,
  START_NODE_ID,
  type WfMeta,
} from "./yaml-utils";
import {
  workflowEngineApi,
  type DAGSnapshot,
  type DAGEvent,
  type NodeOutput,
  type PendingApproval,
  type DAGStatus,
} from "../../api/workflow-engine";
import { workflowDefApi } from "../../api/workflow-defs";
import "./workflow.css";

const PALETTE_ITEMS = [
  { type: "shell", label: "Shell", icon: Terminal, color: "#3b82f6" },
  { type: "agent", label: "Agent", icon: Bot, color: "#22c55e" },
  { type: "api", label: "API", icon: Globe, color: "#8b5cf6" },
  { type: "audit", label: "审批", icon: ShieldCheck, color: "#f59e0b" },
  { type: "workflow", label: "子流程", icon: GitBranch, color: "#ec4899" },
  { type: "loop", label: "循环", icon: RefreshCw, color: "#06b6d4" },
] as const;

interface WorkflowEditorProps {
  workflowId?: string;
  onViewRuns?: () => void;
}

function WorkflowEditorInner({ workflowId, onViewRuns }: WorkflowEditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([createStartNode()]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView, screenToFlowPosition } = useReactFlow();

  const [meta, setMeta] = useState<WfMeta>({ ...defaultMeta });
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlText, setYamlText] = useState("");
  const [readOnly, setReadOnly] = useState(false);

  // dryRun / run 状态
  const [dryRunResult, setDryRunResult] = useState<{
    valid: boolean;
    issues: Array<{ type: string; message: string; field?: string }>;
  } | null>(null);
  const [running, setRunning] = useState(false);

  // ── 运行模式状态 ──
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runSnapshot, setRunSnapshot] = useState<DAGSnapshot | null>(null);
  const [runEvents, setRunEvents] = useState<DAGEvent[]>([]);
  const [runApprovals, setRunApprovals] = useState<PendingApproval[]>([]);
  const [selectedRunNodeId, setSelectedRunNodeId] = useState<string | null>(null);
  const [selectedNodeOutput, setSelectedNodeOutput] = useState<NodeOutput | null>(null);
  const [nodeOutputLoading, setNodeOutputLoading] = useState(false);
  const [runRightTab, setRunRightTab] = useState<"events" | "output">("events");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRunMode = activeRunId !== null;
  const dagStatus = runSnapshot?.dag_status;
  const isRunDone = dagStatus ? ["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(dagStatus) : false;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingConnectSource = useRef<string | null>(null);
  const didConnect = useRef(false);

  // 保存/发布状态
  const [lastSavedYaml, setLastSavedYaml] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [publishing, setPublishing] = useState(false);

  // 加载已保存的工作流草稿
  useEffect(() => {
    if (!workflowId) return;
    (async () => {
      try {
        const wf = await workflowDefApi.get(workflowId);
        if (wf.draftYaml) {
          const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
          setNodes(newNodes);
          setEdges(newEdges);
          setMeta(newMeta);
          setLastSavedYaml(wf.draftYaml);
          setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
        }
        if (wf.name) setMeta((m) => ({ ...m, name: wf.name }));
        if (wf.description) setMeta((m) => ({ ...m, description: wf.description }));
      } catch (err) {
        console.error("加载工作流失败:", err);
      }
    })();
  }, [workflowId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Selection ──
  const onSelectionChange: OnSelectionChangeFunc = useCallback(({ nodes: selNodes }) => {
    setSelectedNode(selNodes[0] ?? null);
    if (activeRunId && selNodes[0] && selNodes[0].id !== START_NODE_ID) {
      setSelectedRunNodeId(selNodes[0].id);
    }
  }, [activeRunId]);

  // ── Connection ──
  const onConnect = useCallback(
    (connection: Connection) => {
      didConnect.current = true;
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: "smoothstep",
            animated: connection.source !== START_NODE_ID,
            id: `e-${connection.source}-${connection.target}`,
          },
          eds,
        ),
      );
    },
    [setEdges],
  );

  // ── Drag-to-create ──
  const onConnectStart = useCallback(({ nodeId }: { nodeId: string | null }) => {
    pendingConnectSource.current = nodeId;
    didConnect.current = false;
  }, []);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const sourceId = pendingConnectSource.current;
      pendingConnectSource.current = null;

      if (!sourceId || readOnly || didConnect.current) return;
      didConnect.current = false;

      const sourceNode = nodes.find((n) => n.id === sourceId);
      if (!sourceNode) return;

      const newType = sourceId === START_NODE_ID ? "shell" : (sourceNode.type ?? "shell");
      const newId = nextNodeId(newType);
      const position = screenToFlowPosition({
        x: (event as MouseEvent).clientX,
        y: (event as MouseEvent).clientY,
      });

      const newNode: Node = { id: newId, type: newType, position, data: {} };
      setNodes((nds) => [...nds, newNode]);
      setEdges((eds) => [
        ...eds,
        {
          id: `e-${sourceId}-${newId}`,
          source: sourceId,
          target: newId,
          type: "smoothstep",
          animated: sourceId !== START_NODE_ID,
        },
      ]);
    },
    [nodes, readOnly, screenToFlowPosition, setNodes, setEdges],
  );

  // ── Prevent deleting start node ──
  const handleNodesDelete = useCallback(
    (deleted: Node[]) => {
      const filtered = deleted.filter((n) => n.id !== START_NODE_ID);
      if (filtered.length === 0) return;
      setNodes((nds) => nds.filter((n) => !filtered.some((d) => d.id === n.id)));
    },
    [setNodes],
  );

  // ── Sync YAML ──
  const syncYaml = useCallback(() => {
    const y = flowToYaml(nodes, edges, meta);
    setYamlText(y);
    return y;
  }, [nodes, edges, meta]);

  // ── Add node at position ──
  const addNode = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      const id = nextNodeId(type);
      const newNode: Node = {
        id,
        type,
        position: position ?? { x: 300 + Math.random() * 200, y: 100 + Math.random() * 200 },
        data: {},
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [setNodes],
  );

  // ── DnD: drag from palette ──
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/workflow-node");
      if (!type) return;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode(type, position);
    },
    [screenToFlowPosition, addNode],
  );

  // ── Auto layout ──
  const handleAutoLayout = useCallback(() => {
    const laid = autoLayout(nodes, edges);
    setNodes(laid);
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
  }, [nodes, edges, setNodes, fitView]);

  // ── New workflow ──
  const handleNew = useCallback(() => {
    setNodes([createStartNode()]);
    setEdges([]);
    setSelectedNode(null);
    setMeta({ ...defaultMeta });
    setYamlText("");
    setDryRunResult(null);
    resetNodeCounter();
  }, [setNodes, setEdges]);

  // ── Import YAML ──
  const handleImportYaml = useCallback(() => {
    if (yamlOpen) {
      const text = yamlText.trim();
      if (!text) return;
      try {
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(text);
        setNodes(newNodes);
        setEdges(newEdges);
        setMeta(newMeta);
        setSelectedNode(null);
        setDryRunResult(null);
        setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
      } catch (err) {
        console.error(err);
        alert("YAML 解析失败: " + (err instanceof Error ? err.message : String(err)));
      }
    } else {
      syncYaml();
      setYamlOpen(true);
    }
  }, [yamlOpen, yamlText, setNodes, setEdges, syncYaml, fitView]);

  // ── Export YAML ──
  const handleExportYaml = useCallback(() => {
    const y = syncYaml();
    const blob = new Blob([y], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meta.name || "workflow"}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  }, [syncYaml, meta.name]);

  // ── Import from file ──
  const handleFileImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        try {
          const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(text);
          setNodes(newNodes);
          setEdges(newEdges);
          setMeta(newMeta);
          setSelectedNode(null);
          setYamlText(text);
          setDryRunResult(null);
          setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
        } catch (err) {
          console.error(err);
          alert("文件解析失败: " + (err instanceof Error ? err.message : String(err)));
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [setNodes, setEdges, fitView],
  );

  // ── Save Draft ──
  const handleSaveDraft = useCallback(async () => {
    if (!workflowId) return;
    const y = syncYaml();
    setSaveStatus("saving");
    try {
      await workflowDefApi.save(workflowId, y);
      setLastSavedYaml(y);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      console.error(err);
      alert("保存失败: " + (err as Error).message);
      setSaveStatus("idle");
    }
  }, [syncYaml, workflowId]);

  // ── Publish ──
  const handlePublish = useCallback(async () => {
    if (!workflowId) return;
    const y = syncYaml();
    setSaveStatus("saving");
    try {
      await workflowDefApi.save(workflowId, y);
      setLastSavedYaml(y);
      setSaveStatus("idle");
    } catch (err) {
      console.error(err);
      alert("保存失败: " + (err as Error).message);
      setSaveStatus("idle");
      return;
    }

    setPublishing(true);
    try {
      const result = await workflowDefApi.publish(workflowId);
      alert(`已发布为 v${result.version}`);
    } catch (err) {
      console.error(err);
      alert("发布失败: " + (err as Error).message);
    } finally {
      setPublishing(false);
    }
  }, [syncYaml, workflowId]);

  // ── Cmd+S shortcut ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSaveDraft();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSaveDraft]);

  // ── Dry Run ──
  const handleDryRun = useCallback(async () => {
    const y = syncYaml();
    setRunning(true);
    setDryRunResult(null);
    try {
      const result = await workflowEngineApi.dryRun(y);
      setDryRunResult(result);
    } catch (err) {
      console.error(err);
      setDryRunResult({ valid: false, issues: [{ type: "error", message: (err as Error).message }] });
    } finally {
      setRunning(false);
    }
  }, [syncYaml]);

  // ── Run mode helpers ──

  /** 将 snapshot 的节点状态同步到编辑器节点 */
  const updateNodesFromSnapshot = useCallback(
    (snap: DAGSnapshot) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === START_NODE_ID) return n;
          const state = snap.node_states[n.id];
          if (!state) return { ...n, data: { ...n.data, _runStatus: undefined, _exitCode: undefined } };
          return { ...n, data: { ...n.data, _runStatus: state.status, _exitCode: state.exit_code } };
        }),
      );
    },
    [setNodes],
  );

  /** 加载运行快照和事件 */
  const loadRunData = useCallback(
    async (runId: string) => {
      try {
        const [snap, evts] = await Promise.all([
          workflowEngineApi.getRunStatus(runId),
          workflowEngineApi.getEvents(runId),
        ]);
        if (snap) {
          setRunSnapshot(snap);
          updateNodesFromSnapshot(snap);
        }
        if (Array.isArray(evts)) setRunEvents(evts);
      } catch (err) {
        console.error(err);
      }
    },
    [updateNodesFromSnapshot],
  );

  // 轮询运行中的工作流
  useEffect(() => {
    if (!activeRunId || !runSnapshot) return;
    const status = runSnapshot.dag_status;
    if (["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(() => loadRunData(activeRunId), 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeRunId, runSnapshot, loadRunData]);

  // SUSPENDED 时加载审批列表
  useEffect(() => {
    if (!activeRunId || !runSnapshot || runSnapshot.dag_status !== "SUSPENDED") {
      setRunApprovals([]);
      return;
    }
    workflowEngineApi
      .getPendingApprovals(activeRunId)
      .then((list) => setRunApprovals(Array.isArray(list) ? list : []))
      .catch((err) => console.error(err));
  }, [activeRunId, runSnapshot]);

  // 选中节点 → 加载输出
  useEffect(() => {
    if (!activeRunId || !selectedRunNodeId) return;
    setNodeOutputLoading(true);
    setSelectedNodeOutput(null);
    setRunRightTab("output");
    workflowEngineApi
      .getOutput(activeRunId, selectedRunNodeId)
      .then((out) => setSelectedNodeOutput(out ?? null))
      .catch((err) => console.error(err))
      .finally(() => setNodeOutputLoading(false));
  }, [activeRunId, selectedRunNodeId]);

  // ── Run workflow（自动保存再执行，结果内联显示） ──
  const handleRun = useCallback(async () => {
    const y = syncYaml();
    setRunning(true);
    setDryRunResult(null);

    if (workflowId) {
      try {
        await workflowDefApi.save(workflowId, y);
      } catch (err) {
        console.error("自动保存失败:", err);
      }
    }

    // 所有节点标记为 RUNNING（等待 API 返回）
    setNodes((nds) =>
      nds.map((n) =>
        n.id === START_NODE_ID
          ? n
          : { ...n, data: { ...n.data, _runStatus: "RUNNING", _exitCode: undefined } },
      ),
    );

    try {
      const result = await workflowEngineApi.run(y);
      setActiveRunId(result.runId);
      setRunSnapshot(null);
      setRunEvents([]);
      setRunApprovals([]);
      setSelectedRunNodeId(null);
      setSelectedNodeOutput(null);
      await loadRunData(result.runId);
    } catch (err) {
      console.error(err);
      // 重置节点状态
      setNodes((nds) =>
        nds.map((n) =>
          n.id === START_NODE_ID
            ? n
            : { ...n, data: { ...n.data, _runStatus: undefined, _exitCode: undefined } },
        ),
      );
      alert("执行失败: " + (err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [syncYaml, workflowId, setNodes, loadRunData]);

  // ── Cancel run ──
  const handleCancelRun = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await workflowEngineApi.cancel(activeRunId);
      await loadRunData(activeRunId);
    } catch (err) {
      console.error(err);
      alert((err as Error).message);
    }
  }, [activeRunId, loadRunData]);

  // ── Approve ──
  const handleApprove = useCallback(
    async (approval: PendingApproval) => {
      if (!activeRunId) return;
      try {
        await workflowEngineApi.approve(activeRunId, approval.nodeId, approval.approvalToken);
        await loadRunData(activeRunId);
        const list = await workflowEngineApi.getPendingApprovals(activeRunId);
        setRunApprovals(Array.isArray(list) ? list : []);
      } catch (err) {
        console.error(err);
        alert((err as Error).message);
      }
    },
    [activeRunId, loadRunData],
  );

  // ── Back to edit ──
  const handleBackToEdit = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setActiveRunId(null);
    setRunSnapshot(null);
    setRunEvents([]);
    setRunApprovals([]);
    setSelectedRunNodeId(null);
    setSelectedNodeOutput(null);
    setNodes((nds) =>
      nds.map((n) => ({ ...n, data: { ...n.data, _runStatus: undefined, _exitCode: undefined } })),
    );
  }, [setNodes]);

  // ── Update selected node data ──
  const updateNodeData = useCallback(
    (updates: Record<string, unknown>) => {
      if (!selectedNode) return;
      setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, ...updates } } : n)));
      setSelectedNode((prev) => (prev ? { ...prev, data: { ...prev.data, ...updates } } : null));
    },
    [selectedNode, setNodes],
  );

  // ── Change node ID ──
  const handleIdChange = useCallback(
    (newId: string) => {
      if (!selectedNode || newId === selectedNode.id || !newId.trim()) return;
      if (newId === START_NODE_ID) return;
      if (nodes.some((n) => n.id === newId)) {
        alert("节点 ID 已存在");
        return;
      }
      const oldId = selectedNode.id;
      const newNode: Node = { ...selectedNode, id: newId };
      const newEdges = edges.map((e) => ({
        ...e,
        source: e.source === oldId ? newId : e.source,
        target: e.target === oldId ? newId : e.target,
        id:
          e.source === oldId || e.target === oldId
            ? `e-${e.source === oldId ? newId : e.source}-${e.target === oldId ? newId : e.target}`
            : e.id,
      }));
      setNodes((nds) => [...nds.filter((n) => n.id !== oldId), newNode]);
      setEdges(newEdges);
      setSelectedNode(newNode);
    },
    [selectedNode, nodes, edges, setNodes, setEdges],
  );

  // ── Update meta ──
  const updateMeta = useCallback((updates: Partial<WfMeta>) => {
    setMeta((prev) => ({ ...prev, ...updates }));
  }, []);

  const sd = selectedNode?.data as Record<string, unknown> | undefined;
  const nodeType = selectedNode?.type ?? "shell";
  const isStartNode = selectedNode?.id === START_NODE_ID;

  return (
    <div className="wf-editor-container">
      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml"
        onChange={handleFileImport}
        style={{ display: "none" }}
      />

      {readOnly && (
        <div className="wf-readonly-badge">
          <Lock size={12} /> 只读模式
        </div>
      )}

      <div className="wf-canvas-wrapper">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={readOnly ? undefined : onNodesChange}
          onEdgesChange={readOnly ? undefined : onEdgesChange}
          onNodesDelete={handleNodesDelete}
          onSelectionChange={onSelectionChange}
          onConnect={readOnly ? undefined : onConnect}
          onConnectStart={readOnly ? undefined : onConnectStart}
          onConnectEnd={readOnly ? undefined : onConnectEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
          nodeTypes={nodeTypes}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable
          deleteKeyCode={readOnly ? null : "Delete"}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          defaultEdgeOptions={{ type: "smoothstep", animated: true }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          className={readOnly ? "wf-canvas-readonly" : ""}
        >
          <Controls position="bottom-left" showInteractive={!readOnly} />
          <MiniMap
            position="bottom-right"
            nodeColor={(n) => {
              const colorMap: Record<string, string> = {
                start: "#6366f1",
                agent: "#22c55e",
                api: "#8b5cf6",
                audit: "#f59e0b",
                workflow: "#ec4899",
                loop: "#06b6d4",
              };
              return colorMap[n.type ?? ""] ?? "#3b82f6";
            }}
            maskColor="rgba(0,0,0,0.08)"
            style={{ borderRadius: 8 }}
          />
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#d1d5db" />

          {/* 节点面板 */}
          {!readOnly && (
            <Panel position="top-left" className="wf-panel-palette">
              <div className="wf-palette">
                <div className="wf-palette-title">拖拽或点击添加</div>
                {PALETTE_ITEMS.map(({ type, label, icon: Icon, color }) => (
                  <button
                    key={type}
                    type="button"
                    className="wf-palette-btn"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/workflow-node", type);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => addNode(type)}
                  >
                    <span className="wf-palette-icon" style={{ background: color }}>
                      <Icon size={14} />
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            </Panel>
          )}

          {/* 工具栏 */}
          <Panel position="top-center" className="wf-panel-toolbar">
            <div className="wf-toolbar">
              {!readOnly && (
                <button type="button" className="wf-toolbar-btn" onClick={handleNew} title="新建">
                  <FilePlus size={15} />
                </button>
              )}
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={() => fileInputRef.current?.click()}
                title="导入文件"
              >
                <Upload size={15} />
              </button>
              <button type="button" className="wf-toolbar-btn" onClick={handleExportYaml} title="导出 YAML">
                <Download size={15} />
              </button>
              <div className="wf-toolbar-divider" />
              <button type="button" className="wf-toolbar-btn" onClick={handleAutoLayout} title="自动排列">
                <LayoutGrid size={15} />
              </button>
              {workflowId && (
                <>
                  <div className="wf-toolbar-divider" />
                  <button
                    type="button"
                    className="wf-toolbar-btn"
                    onClick={handleSaveDraft}
                    disabled={saveStatus === "saving"}
                    title="保存草稿 (Cmd+S)"
                  >
                    <Save size={15} />
                  </button>
                  <button
                    type="button"
                    className="wf-toolbar-btn"
                    onClick={handlePublish}
                    disabled={publishing}
                    title="发布版本"
                    style={{ color: "#22c55e" }}
                  >
                    <Rocket size={15} />
                  </button>
                </>
              )}
              <button
                type="button"
                className={`wf-toolbar-btn ${yamlOpen ? "active" : ""}`}
                onClick={() => {
                  if (!yamlOpen) syncYaml();
                  setYamlOpen(!yamlOpen);
                }}
                title="YAML"
              >
                <Code size={15} />
              </button>
              <div className="wf-toolbar-divider" />
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={handleDryRun}
                disabled={running}
                title="校验 (dryRun)"
              >
                <CheckCircle size={15} />
              </button>
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={handleRun}
                disabled={running}
                title="执行工作流"
                style={running ? { opacity: 0.5 } : undefined}
              >
                <Play size={15} />
              </button>
              <div className="wf-toolbar-divider" />
              <button
                type="button"
                className={`wf-toolbar-btn ${readOnly ? "active" : ""}`}
                onClick={() => setReadOnly(!readOnly)}
                title={readOnly ? "切换到编辑模式" : "切换到只读模式"}
              >
                {readOnly ? <Eye size={15} /> : <Edit3 size={15} />}
              </button>
              {onViewRuns && (
                <>
                  <div className="wf-toolbar-divider" />
                  <button
                    type="button"
                    className="wf-toolbar-btn"
                    onClick={onViewRuns}
                    title="运行记录"
                  >
                    <List size={15} />
                  </button>
                </>
              )}
            </div>
          </Panel>
        </ReactFlow>

        {/* 保存状态指示器 */}
        {saveStatus === "saving" && (
          <div style={{
            position: "absolute", top: 52, left: "50%", transform: "translateX(-50%)",
            background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 8,
            padding: "6px 12px", fontSize: 11, color: "#1d4ed8", zIndex: 10,
          }}>
            保存中...
          </div>
        )}
        {saveStatus === "saved" && (
          <div style={{
            position: "absolute", top: 52, left: "50%", transform: "translateX(-50%)",
            background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8,
            padding: "6px 12px", fontSize: 11, color: "#166534", zIndex: 10,
          }}>
            已保存
          </div>
        )}

        {/* DryRun 结果提示 */}
        {dryRunResult && (
          <div
            style={{
              position: "absolute",
              top: 52,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 10,
              background: dryRunResult.valid ? "#f0fdf4" : "#fef2f2",
              border: `1px solid ${dryRunResult.valid ? "#86efac" : "#fca5a5"}`,
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 12,
              color: dryRunResult.valid ? "#166534" : "#991b1b",
              maxWidth: 480,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, marginBottom: dryRunResult.issues.length ? 4 : 0 }}>
              {dryRunResult.valid ? <CheckCircle size={13} /> : <AlertTriangle size={13} />}
              {dryRunResult.valid ? "校验通过" : `校验失败 (${dryRunResult.issues.length} 个问题)`}
              <button
                type="button"
                onClick={() => setDryRunResult(null)}
                style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", padding: 0, color: "inherit" }}
              >
                <X size={12} />
              </button>
            </div>
            {dryRunResult.issues.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {dryRunResult.issues.map((issue, i) => (
                  <li key={i}>
                    {issue.type === "error" ? "❌" : "⚠️"} {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* YAML 滑出面板 */}
        <div className={`wf-yaml-slide ${yamlOpen ? "open" : ""}`}>
          <div className="wf-yaml-slide-header">
            <span className="wf-yaml-slide-title">YAML</span>
            <div style={{ display: "flex", gap: 4 }}>
              {!readOnly && (
                <button type="button" className="wf-toolbar-btn" onClick={handleImportYaml} title="应用 YAML">
                  <Upload size={14} />
                </button>
              )}
              <button type="button" className="wf-toolbar-btn" onClick={() => setYamlOpen(false)}>
                <X size={14} />
              </button>
            </div>
          </div>
          <textarea
            className="wf-yaml-textarea"
            value={yamlText}
            onChange={(e) => setYamlText(e.target.value)}
            spellCheck={false}
            placeholder="# YAML 内容"
            readOnly={readOnly}
          />
        </div>
      </div>

      {/* 右侧属性面板 */}
      <aside className="wf-prop-panel">
        {isRunMode ? (
          /* ── 运行模式面板 ── */
          <>
            <div className="wf-prop-header" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="wf-prop-title">运行结果</span>
              {runSnapshot && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    padding: "1px 7px",
                    borderRadius: 99,
                    fontSize: 10,
                    fontWeight: 500,
                    color: DAG_STATUS_CFG[dagStatus!]?.color ?? "#6b7280",
                    background: DAG_STATUS_CFG[dagStatus!]?.bg ?? "#f3f4f6",
                  }}
                >
                  {dagStatus === "RUNNING" && (
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: "#3b82f6",
                        animation: "wf-pulse 1.5s ease-in-out infinite",
                      }}
                    />
                  )}
                  {DAG_STATUS_CFG[dagStatus!]?.label ?? dagStatus}
                </span>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                {!isRunDone && (
                  <button
                    type="button"
                    onClick={handleCancelRun}
                    title="取消运行"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      border: "none",
                      background: "#fef2f2",
                      borderRadius: 4,
                      color: "#ef4444",
                      cursor: "pointer",
                    }}
                  >
                    <Square size={11} />
                  </button>
                )}
                {isRunDone && (
                  <button
                    type="button"
                    onClick={handleBackToEdit}
                    title="返回编辑"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      border: "none",
                      background: "#f3f4f6",
                      borderRadius: 4,
                      color: "#6b7280",
                      cursor: "pointer",
                    }}
                  >
                    <Edit3 size={11} />
                  </button>
                )}
              </div>
            </div>

            {/* 审批卡片 */}
            {dagStatus === "SUSPENDED" && runApprovals.length > 0 && (
              <div
                style={{
                  padding: 10,
                  borderBottom: "1px solid #fbbf24",
                  background: "#fffbeb",
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#92400e",
                    marginBottom: 6,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <ShieldCheck size={12} /> 等待审批
                </div>
                {runApprovals.map((a) => (
                  <div key={a.nodeId} style={{ fontSize: 10, color: "#78350f", marginBottom: 6 }}>
                    <div style={{ fontWeight: 500, marginBottom: 2 }}>节点: {a.nodeId}</div>
                    {a.displayData && typeof a.displayData === "object" && (
                      <div style={{ color: "#92400e", marginBottom: 3 }}>
                        {(a.displayData as Record<string, string>).message ?? ""}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => handleApprove(a)}
                      style={{
                        padding: "2px 8px",
                        border: "1px solid #f59e0b",
                        borderRadius: 4,
                        background: "#f59e0b",
                        color: "#fff",
                        fontSize: 10,
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

            {/* 进度条 */}
            {runSnapshot && (
              <div
                style={{
                  padding: "4px 12px",
                  borderBottom: "1px solid #f3f4f6",
                  fontSize: 10,
                  color: "#9ca3af",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>
                  {Object.values(runSnapshot.node_states).filter((s) => s.status === "COMPLETED").length}/
                  {Object.keys(runSnapshot.node_states).length} 节点
                </span>
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 9 }}>
                  {activeRunId?.substring(0, 16)}...
                </span>
              </div>
            )}

            {/* Tab 切换 */}
            <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb" }}>
              <button
                type="button"
                onClick={() => setRunRightTab("events")}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  border: "none",
                  background: "none",
                  fontSize: 11,
                  fontWeight: runRightTab === "events" ? 600 : 400,
                  color: runRightTab === "events" ? "#111827" : "#9ca3af",
                  borderBottom: runRightTab === "events" ? "2px solid #3b82f6" : "2px solid transparent",
                  cursor: "pointer",
                }}
              >
                事件流 ({selectedRunNodeId ? runEvents.filter((e) => e.node_id === selectedRunNodeId).length : runEvents.length})
              </button>
              <button
                type="button"
                onClick={() => setRunRightTab("output")}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  border: "none",
                  background: "none",
                  fontSize: 11,
                  fontWeight: runRightTab === "output" ? 600 : 400,
                  color: runRightTab === "output" ? "#111827" : "#9ca3af",
                  borderBottom: runRightTab === "output" ? "2px solid #3b82f6" : "2px solid transparent",
                  cursor: "pointer",
                }}
              >
                {selectedRunNodeId ? `输出 (${selectedRunNodeId})` : "节点输出"}
              </button>
            </div>

            {/* 事件列表 */}
            {runRightTab === "events" && (
              <div style={{ flex: 1, overflowY: "auto", fontSize: 11 }}>
                {(() => {
                  const filtered = selectedRunNodeId
                    ? runEvents.filter((e) => e.node_id === selectedRunNodeId)
                    : runEvents;
                  return filtered.length === 0 ? (
                    <div style={{ padding: 20, textAlign: "center", color: "#d1d5db" }}>
                      {selectedRunNodeId ? "该节点暂无事件" : "暂无事件"}
                    </div>
                  ) : (
                    filtered.map((evt) => (
                      <div
                        key={evt.event_id}
                        style={{
                          padding: "5px 10px",
                          borderBottom: "1px solid #f3f4f6",
                          display: "flex",
                          gap: 5,
                          alignItems: "flex-start",
                          cursor: evt.node_id ? "pointer" : "default",
                        }}
                        onClick={() => {
                          if (evt.node_id) setSelectedRunNodeId(evt.node_id);
                        }}
                      >
                        <EventIcon type={evt.type} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 1 }}>
                            <span style={{ fontWeight: 500, color: "#374151" }}>{formatEventType(evt.type)}</span>
                            <span style={{ color: "#d1d5db", fontSize: 9, flexShrink: 0 }}>
                              {new Date(evt.timestamp).toLocaleTimeString("zh-CN", {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                              })}
                            </span>
                          </div>
                          {evt.node_id && (
                            <span
                              style={{ color: "#9ca3af", fontFamily: "ui-monospace, monospace", fontSize: 9 }}
                            >
                              {evt.node_id}
                            </span>
                          )}
                          {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                            <div
                              style={{
                                color: "#9ca3af",
                                fontSize: 9,
                                marginTop: 1,
                                fontFamily: "ui-monospace, monospace",
                              }}
                            >
                              {formatMeta(evt.type, evt.metadata)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  );
                })()}
              </div>
            )}

            {/* 节点输出 */}
            {runRightTab === "output" && (
              <div style={{ flex: 1, overflowY: "auto", fontSize: 11 }}>
                {!selectedRunNodeId ? (
                  <div style={{ padding: 20, textAlign: "center", color: "#d1d5db" }}>点击节点查看输出</div>
                ) : nodeOutputLoading ? (
                  <div style={{ padding: 20, textAlign: "center", color: "#9ca3af" }}>
                    <Loader size={14} style={{ animation: "wf-spin 1s linear infinite", display: "inline-block" }} />
                  </div>
                ) : !selectedNodeOutput ? (
                  <div style={{ padding: 20, textAlign: "center", color: "#d1d5db" }}>暂无输出</div>
                ) : (
                  <NodeOutputView output={selectedNodeOutput} />
                )}
              </div>
            )}
          </>
        ) : (
          /* ── 编辑模式面板（原有内容） ── */
          <>
            <div className="wf-prop-header">
              <span className="wf-prop-title">
                {isStartNode ? "开始节点" : selectedNode ? "节点属性" : "工作流"}
              </span>
              {readOnly && (
                <span className="wf-prop-readonly-tag">
                  <Lock size={10} /> 只读
                </span>
              )}
            </div>
        <div className="wf-prop-body">
          {/* ── 开始节点 ── */}
          {isStartNode ? (
            <div className="wf-prop-section">
              <div className="wf-prop-section-title">开始节点</div>
              <div className="wf-prop-hint">
                <p>这是工作流的入口点，不可删除。</p>
                <p>从右侧端口拖出连线创建第一个任务节点。</p>
              </div>
            </div>
          ) : selectedNode ? (
            <>
              {/* ── 节点基本信息 ── */}
              <div className="wf-prop-section">
                <div className="wf-prop-section-title">基本信息</div>
                <div className="wf-prop-field">
                  <label>节点 ID</label>
                  <input value={selectedNode.id} onChange={(e) => handleIdChange(e.target.value)} readOnly={readOnly} />
                </div>
                <div className="wf-prop-field">
                  <label>类型</label>
                  <select
                    value={nodeType}
                    onChange={(e) => {
                      const newType = e.target.value;
                      setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, type: newType } : n)));
                      setSelectedNode((prev) => (prev ? { ...prev, type: newType } : null));
                    }}
                    disabled={readOnly}
                  >
                    <option value="shell">Shell</option>
                    <option value="agent">Agent</option>
                    <option value="api">API</option>
                    <option value="audit">审批 (Audit)</option>
                    <option value="workflow">子流程 (Workflow)</option>
                    <option value="loop">循环 (Loop)</option>
                  </select>
                </div>
              </div>

              {/* ── 节点配置（按类型） ── */}
              <div className="wf-prop-section">
                <div className="wf-prop-section-title">配置</div>

                {nodeType === "shell" && (
                  <>
                    <div className="wf-prop-field">
                      <label>命令 (command)</label>
                      <textarea
                        value={String(sd?.command ?? "")}
                        onChange={(e) => updateNodeData({ command: e.target.value })}
                        placeholder='echo "Hello ${{ params.name }}"'
                        rows={3}
                        readOnly={readOnly}
                      />
                    </div>
                    <div className="wf-prop-field">
                      <label>环境变量</label>
                      <textarea
                        value={String(sd?.env ?? "")}
                        onChange={(e) => updateNodeData({ env: e.target.value })}
                        placeholder="KEY=value（每行一个）"
                        rows={2}
                        readOnly={readOnly}
                      />
                    </div>
                  </>
                )}

                {nodeType === "agent" && (
                  <>
                    <div className="wf-prop-field">
                      <label>Prompt</label>
                      <textarea
                        value={String(sd?.prompt ?? "")}
                        onChange={(e) => updateNodeData({ prompt: e.target.value })}
                        placeholder="描述任务..."
                        rows={4}
                        readOnly={readOnly}
                      />
                    </div>
                    <div className="wf-prop-field">
                      <label>Agent 名称</label>
                      <input
                        value={String(sd?.agent ?? "")}
                        onChange={(e) => updateNodeData({ agent: e.target.value })}
                        placeholder="general"
                        readOnly={readOnly}
                      />
                    </div>
                    <div className="wf-prop-field">
                      <label>Skill</label>
                      <input
                        value={String(sd?.skill ?? "")}
                        onChange={(e) => updateNodeData({ skill: e.target.value })}
                        placeholder="skill-name"
                        readOnly={readOnly}
                      />
                    </div>
                  </>
                )}

                {nodeType === "api" && (
                  <>
                    <div className="wf-prop-field">
                      <label>URL</label>
                      <input
                        value={String(sd?.url ?? "")}
                        onChange={(e) => updateNodeData({ url: e.target.value })}
                        placeholder="https://api.example.com/data"
                        readOnly={readOnly}
                      />
                    </div>
                    <div className="wf-prop-field">
                      <label>方法</label>
                      <select
                        value={String(sd?.method ?? "GET")}
                        onChange={(e) => updateNodeData({ method: e.target.value })}
                        disabled={readOnly}
                      >
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                        <option value="PATCH">PATCH</option>
                        <option value="DELETE">DELETE</option>
                      </select>
                    </div>
                    <div className="wf-prop-field">
                      <label>Headers (JSON)</label>
                      <textarea
                        value={String(sd?.headers ?? "")}
                        onChange={(e) => updateNodeData({ headers: e.target.value })}
                        placeholder='{"Authorization": "Bearer ${{ secrets.KEY }}"}'
                        rows={2}
                        readOnly={readOnly}
                      />
                    </div>
                    <div className="wf-prop-field">
                      <label>Body</label>
                      <textarea
                        value={String(sd?.body ?? "")}
                        onChange={(e) => updateNodeData({ body: e.target.value })}
                        placeholder='{"key": "value"}'
                        rows={2}
                        readOnly={readOnly}
                      />
                    </div>
                  </>
                )}

                {nodeType === "audit" && (
                  <>
                    <div className="wf-prop-field">
                      <label>审批提示消息</label>
                      <input
                        value={String(
                          (typeof sd?.display_data === "object" && sd?.display_data !== null
                            ? (sd.display_data as Record<string, string>).message
                            : sd?.display_data) ?? "",
                        )}
                        onChange={(e) => updateNodeData({ display_data: { message: e.target.value } })}
                        placeholder="请审核此步骤"
                        readOnly={readOnly}
                      />
                    </div>
                    <div className="wf-prop-field">
                      <label>过期时间 (秒)</label>
                      <input
                        type="number"
                        value={sd?.expires_in != null ? String(sd.expires_in) : ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateNodeData({ expires_in: v ? Number(v) : undefined });
                        }}
                        placeholder="86400"
                        readOnly={readOnly}
                      />
                    </div>
                  </>
                )}

                {nodeType === "workflow" && (
                  <div className="wf-prop-field">
                    <label>子流程路径 (ref)</label>
                    <input
                      value={String(sd?.ref ?? "")}
                      onChange={(e) => updateNodeData({ ref: e.target.value })}
                      placeholder="./sub-workflow.yaml"
                      readOnly={readOnly}
                    />
                  </div>
                )}

                {nodeType === "loop" && (
                  <>
                    <div className="wf-prop-field">
                      <label>循环条件 (condition)</label>
                      <input
                        value={String(sd?.condition ?? "")}
                        onChange={(e) => updateNodeData({ condition: e.target.value })}
                        placeholder="{{ counter < 10 }}"
                        readOnly={readOnly}
                      />
                    </div>
                    <div className="wf-prop-field">
                      <label>最大迭代次数</label>
                      <input
                        type="number"
                        value={sd?.max_iterations != null ? String(sd.max_iterations) : ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateNodeData({ max_iterations: v ? Number(v) : undefined });
                        }}
                        placeholder="10"
                        readOnly={readOnly}
                      />
                    </div>
                    <div className="wf-prop-hint" style={{ marginTop: 4 }}>
                      <p>循环体 (body) 请在 YAML 面板中编辑。</p>
                    </div>
                  </>
                )}
              </div>

              {/* ── 高级配置 ── */}
              <div className="wf-prop-section">
                <div className="wf-prop-section-title">高级</div>
                <div className="wf-prop-field">
                  <label>超时 (秒)</label>
                  <input
                    type="number"
                    value={sd?.timeout != null ? String(sd.timeout) : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateNodeData({ timeout: v ? Number(v) : undefined });
                    }}
                    placeholder="300"
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>重试次数</label>
                  <input
                    type="number"
                    value={sd?.retry != null ? String(sd.retry) : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateNodeData({ retry: v ? Number(v) : undefined });
                    }}
                    placeholder="0"
                    readOnly={readOnly}
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              {/* ── 工作流元数据 ── */}
              <div className="wf-prop-section">
                <div className="wf-prop-section-title">基本信息</div>
                <div className="wf-prop-field">
                  <label>Schema 版本</label>
                  <input value={meta.schema_version} readOnly />
                </div>
                <div className="wf-prop-field">
                  <label>名称</label>
                  <input value={meta.name} onChange={(e) => updateMeta({ name: e.target.value })} readOnly={readOnly} />
                </div>
                <div className="wf-prop-field">
                  <label>描述</label>
                  <textarea
                    value={meta.description}
                    onChange={(e) => updateMeta({ description: e.target.value })}
                    placeholder="工作流描述..."
                    rows={2}
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>超时 (秒)</label>
                  <input
                    type="number"
                    value={meta.timeout}
                    onChange={(e) => updateMeta({ timeout: e.target.value ? Number(e.target.value) : 300 })}
                    placeholder="300"
                    readOnly={readOnly}
                  />
                </div>
              </div>

              <div className="wf-prop-section">
                <div className="wf-prop-section-title">参数 (params)</div>
                <div className="wf-prop-field">
                  <label>参数定义 (JSON)</label>
                  <textarea
                    value={Object.keys(meta.params).length ? JSON.stringify(meta.params, null, 2) : ""}
                    onChange={(e) => {
                      try {
                        const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : {};
                        updateMeta({ params: parsed });
                      } catch {
                        // 用户还在编辑，暂不更新
                      }
                    }}
                    placeholder='{"name": {"type": "string", "default": "World"}}'
                    rows={3}
                    readOnly={readOnly}
                  />
                </div>
              </div>

              <div className="wf-prop-section">
                <div className="wf-prop-section-title">密钥 (secrets)</div>
                <div className="wf-prop-field">
                  <label>环境变量名（每行一个）</label>
                  <textarea
                    value={meta.secrets.join("\n")}
                    onChange={(e) =>
                      updateMeta({
                        secrets: e.target.value
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="API_KEY&#10;DATABASE_URL"
                    rows={2}
                    readOnly={readOnly}
                  />
                </div>
              </div>

              <div className="wf-prop-hint">
                <p>点击画布中的节点查看属性</p>
                {!readOnly && (
                  <>
                    <p>从左侧面板点击或拖拽添加节点</p>
                    <p>从节点右侧端口拖出可快速创建后续节点</p>
                    <p>按 Delete 键删除选中的节点或连线</p>
                  </>
                )}
              </div>
            </>
          )}
        </div>
          </>
        )}
      </aside>
    </div>
  );
}

// ── DAG 状态样式 ──
const DAG_STATUS_CFG: Record<string, { color: string; bg: string; label: string }> = {
  PENDING: { color: "#94a3b8", bg: "#f1f5f9", label: "等待中" },
  RUNNING: { color: "#3b82f6", bg: "#eff6ff", label: "运行中" },
  SUSPENDED: { color: "#f59e0b", bg: "#fffbeb", label: "等待审批" },
  SUCCESS: { color: "#22c55e", bg: "#f0fdf4", label: "成功" },
  FAILED: { color: "#ef4444", bg: "#fef2f2", label: "失败" },
  CANCELLED: { color: "#94a3b8", bg: "#f8fafc", label: "已取消" },
  ERROR: { color: "#ef4444", bg: "#fef2f2", label: "错误" },
};

// ── 事件渲染辅助 ──

function EventIcon({ type }: { type: string }) {
  if (type.startsWith("dag.")) {
    const isOk = type === "dag.completed";
    return isOk ? (
      <CheckCircle size={11} style={{ color: "#22c55e", flexShrink: 0, marginTop: 1 }} />
    ) : type === "dag.cancelled" ? (
      <XCircle size={11} style={{ color: "#94a3b8", flexShrink: 0, marginTop: 1 }} />
    ) : (
      <Play size={11} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 1 }} />
    );
  }
  if (type.includes("failed")) return <XCircle size={11} style={{ color: "#ef4444", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("completed")) return <CheckCircle size={11} style={{ color: "#22c55e", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("started")) return <Loader size={11} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("retrying")) return <RefreshCw size={11} style={{ color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("audit")) return <ShieldCheck size={11} style={{ color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />;
  return <Clock size={11} style={{ color: "#94a3b8", flexShrink: 0, marginTop: 1 }} />;
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
      <div
        style={{
          padding: "5px 10px",
          borderBottom: "1px solid #f3f4f6",
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontSize: 9,
          color: "#6b7280",
        }}
      >
        <span>exit_code: {output.exit_code}</span>
        {output.size != null && <span>· {output.size}B</span>}
        {output.ref && <span style={{ color: "#f59e0b" }}>· 大输出(ref)</span>}
        <button
          type="button"
          onClick={handleCopy}
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 2,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#6b7280",
            fontSize: 9,
          }}
        >
          {copied ? <Check size={10} /> : <Copy size={10} />} {copied ? "已复制" : "复制"}
        </button>
      </div>
      {output.stdout ? (
        <pre
          style={{
            padding: 10,
            margin: 0,
            fontSize: 10,
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
        <div style={{ padding: 14, textAlign: "center", color: "#d1d5db" }}>无输出</div>
      )}
      {output.json !== undefined && output.json !== null && (
        <div style={{ borderTop: "1px solid #f3f4f6" }}>
          <div style={{ padding: "5px 10px", fontSize: 9, color: "#6b7280", fontWeight: 500 }}>JSON 输出</div>
          <pre
            style={{
              padding: 10,
              margin: 0,
              fontSize: 10,
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

export function WorkflowEditor(props: WorkflowEditorProps) {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner {...props} />
    </ReactFlowProvider>
  );
}
