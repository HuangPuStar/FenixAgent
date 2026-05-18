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
  GitBranch,
  Eye,
  Edit3,
  Lock,
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
import "./workflow.css";

function WorkflowEditorInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([createStartNode()]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView, screenToFlowPosition } = useReactFlow();

  const [meta, setMeta] = useState<WfMeta>({ ...defaultMeta });
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlText, setYamlText] = useState("");
  const [readOnly, setReadOnly] = useState(false);

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
          { ...connection, type: "smoothstep", animated: connection.source !== START_NODE_ID, id: `e-${connection.source}-${connection.target}` },
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

      // 如果 onConnect 已经触发（成功连到已有节点），不创建新节点
      if (!sourceId || readOnly || didConnect.current) return;
      didConnect.current = false;

      const sourceNode = nodes.find((n) => n.id === sourceId);
      if (!sourceNode) return;

      const newType = sourceId === START_NODE_ID ? "shell" : sourceNode.type ?? "shell";
      const newId = nextNodeId(newType);
      const position = screenToFlowPosition({
        x: (event as MouseEvent).clientX,
        y: (event as MouseEvent).clientY,
      });

      const newNode: Node = { id: newId, type: newType, position, data: {} };
      setNodes((nds) => [...nds, newNode]);
      setEdges((eds) => [
        ...eds,
        { id: `e-${sourceId}-${newId}`, source: sourceId, target: newId, type: "smoothstep", animated: sourceId !== START_NODE_ID },
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

  // ── Update selected node data ──
  const updateNodeData = useCallback(
    (updates: Record<string, unknown>) => {
      if (!selectedNode) return;
      setNodes((nds) =>
        nds.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, ...updates } } : n)),
      );
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
              if (n.type === "start") return "#6366f1";
              if (n.type === "agent") return "#22c55e";
              if (n.type === "reference") return "#f59e0b";
              return "#3b82f6";
            }}
            maskColor="rgba(0,0,0,0.08)"
            style={{ borderRadius: 8 }}
          />
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#d1d5db" />

          {!readOnly && (
            <Panel position="top-left" className="wf-panel-palette">
              <div className="wf-palette">
                <div className="wf-palette-title">拖拽或点击添加</div>
                <button
                  type="button"
                  className="wf-palette-btn"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/workflow-node", "shell");
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => addNode("shell")}
                >
                  <span className="wf-palette-icon" style={{ background: "#3b82f6" }}>
                    <Terminal size={14} />
                  </span>
                  Shell
                </button>
                <button
                  type="button"
                  className="wf-palette-btn"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/workflow-node", "agent");
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => addNode("agent")}
                >
                  <span className="wf-palette-icon" style={{ background: "#22c55e" }}>
                    <Bot size={14} />
                  </span>
                  Agent
                </button>
                <button
                  type="button"
                  className="wf-palette-btn"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/workflow-node", "reference");
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => addNode("reference")}
                >
                  <span className="wf-palette-icon" style={{ background: "#f59e0b" }}>
                    <GitBranch size={14} />
                  </span>
                  引用
                </button>
              </div>
            </Panel>
          )}

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
                className={`wf-toolbar-btn ${readOnly ? "active" : ""}`}
                onClick={() => setReadOnly(!readOnly)}
                title={readOnly ? "切换到编辑模式" : "切换到只读模式"}
              >
                {readOnly ? <Eye size={15} /> : <Edit3 size={15} />}
              </button>
            </div>
          </Panel>
        </ReactFlow>

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

      {/* Right Panel */}
      <aside className="wf-prop-panel">
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
              <div className="wf-prop-section">
                <div className="wf-prop-section-title">基本信息</div>
                <div className="wf-prop-field">
                  <label>节点 ID</label>
                  <input
                    value={selectedNode.id}
                    onChange={(e) => handleIdChange(e.target.value)}
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>类型</label>
                  <select
                    value={nodeType}
                    onChange={(e) => {
                      const newType = e.target.value;
                      setNodes((nds) =>
                        nds.map((n) => (n.id === selectedNode.id ? { ...n, type: newType } : n)),
                      );
                      setSelectedNode((prev) => (prev ? { ...prev, type: newType } : null));
                    }}
                    disabled={readOnly}
                  >
                    <option value="shell">Shell</option>
                    <option value="agent">Agent</option>
                    <option value="reference">引用</option>
                  </select>
                </div>
              </div>

              <div className="wf-prop-section">
                <div className="wf-prop-section-title">配置</div>

                {nodeType === "shell" && (
                  <>
                    <div className="wf-prop-field">
                      <label>命令 (run)</label>
                      <textarea
                        value={String(sd?.run ?? "")}
                        onChange={(e) => updateNodeData({ run: e.target.value })}
                        placeholder="echo hello"
                        rows={3}
                        readOnly={readOnly}
                      />
                    </div>
                    <div className="wf-prop-field">
                      <label>Shell</label>
                      <input
                        value={String(sd?.shell ?? "")}
                        onChange={(e) => updateNodeData({ shell: e.target.value })}
                        placeholder="bash -c"
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
                      <label>模型</label>
                      <input
                        value={String(sd?.model ?? "")}
                        onChange={(e) => updateNodeData({ model: e.target.value })}
                        placeholder="gpt-4o"
                        readOnly={readOnly}
                      />
                    </div>
                  </>
                )}

                {nodeType === "reference" && (
                  <div className="wf-prop-field">
                    <label>工作流名称</label>
                    <input
                      value={String(sd?.workflow ?? "")}
                      onChange={(e) => updateNodeData({ workflow: e.target.value })}
                      placeholder="my-workflow"
                      readOnly={readOnly}
                    />
                  </div>
                )}
              </div>

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
                <div className="wf-prop-field">
                  <label>环境变量</label>
                  <textarea
                    value={String(sd?.env ?? "")}
                    onChange={(e) => updateNodeData({ env: e.target.value })}
                    placeholder="KEY=value"
                    rows={2}
                    readOnly={readOnly}
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="wf-prop-section">
                <div className="wf-prop-section-title">基本信息</div>
                <div className="wf-prop-field">
                  <label>名称</label>
                  <input
                    value={meta.name}
                    onChange={(e) => updateMeta({ name: e.target.value })}
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>版本</label>
                  <input
                    value={meta.version}
                    onChange={(e) => updateMeta({ version: e.target.value })}
                    readOnly={readOnly}
                  />
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
                  <label>默认超时 (秒)</label>
                  <input
                    type="number"
                    value={meta.timeout ?? ""}
                    onChange={(e) => updateMeta({ timeout: e.target.value ? Number(e.target.value) : null })}
                    placeholder="300"
                    readOnly={readOnly}
                  />
                </div>
              </div>

              <div className="wf-prop-section">
                <div className="wf-prop-section-title">默认配置</div>
                <div className="wf-prop-field">
                  <label>默认 Shell</label>
                  <input
                    value={meta.defaults.shell}
                    onChange={(e) =>
                      updateMeta({ defaults: { ...meta.defaults, shell: e.target.value } })
                    }
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>默认重试</label>
                  <input
                    type="number"
                    value={meta.defaults.retry}
                    onChange={(e) =>
                      updateMeta({ defaults: { ...meta.defaults, retry: Number(e.target.value) || 0 } })
                    }
                    readOnly={readOnly}
                  />
                </div>
              </div>

              <div className="wf-prop-hint">
                <p>点击画布中的节点查看属性</p>
                {!readOnly && (
                  <>
                    <p>从左侧面板点击添加节点</p>
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

export function WorkflowEditor() {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner />
    </ReactFlowProvider>
  );
}
