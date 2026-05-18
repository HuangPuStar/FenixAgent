import { useCallback, useRef, useState } from "react";
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
import { workflowEngineApi } from "../../api/workflow-engine";
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
  onViewRuns?: () => void;
  onRunStarted?: (runId: string) => void;
}

function WorkflowEditorInner({ onViewRuns, onRunStarted }: WorkflowEditorProps) {
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingConnectSource = useRef<string | null>(null);
  const didConnect = useRef(false);

  // ── Selection ──
  const onSelectionChange: OnSelectionChangeFunc = useCallback(({ nodes: selNodes }) => {
    setSelectedNode(selNodes[0] ?? null);
  }, []);

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

  // ── Run workflow ──
  const handleRun = useCallback(async () => {
    const y = syncYaml();
    setRunning(true);
    setDryRunResult(null);
    try {
      const result = await workflowEngineApi.run(y);
      if (onRunStarted) {
        onRunStarted(result.runId);
      } else {
        alert(`工作流已提交，runId: ${result.runId}\n状态: ${result.status}`);
      }
    } catch (err) {
      console.error(err);
      alert("执行失败: " + (err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [syncYaml, onRunStarted]);

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
        <div className="wf-prop-header">
          <span className="wf-prop-title">{isStartNode ? "开始节点" : selectedNode ? "节点属性" : "工作流"}</span>
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
      </aside>
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
