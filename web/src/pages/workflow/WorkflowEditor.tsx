import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type OnSelectionChangeFunc,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  Bot,
  CheckCircle,
  Code,
  Download,
  Edit3,
  Eye,
  FilePlus,
  Globe,
  LayoutGrid,
  Link,
  List,
  Lock,
  MessageSquare,
  Play,
  RefreshCw,
  Rocket,
  Save,
  ShieldCheck,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import { workflowDefApi } from "../../api/workflow-defs";
import {
  type DAGEvent,
  type DAGSnapshot,
  type NodeOutput,
  type PendingApproval,
  workflowEngineApi,
} from "../../api/workflow-engine";
import { connectWorkflowSSE, disconnectWorkflowSSE } from "../../api/workflow-sse";
import { MetaAgentPanel } from "./components/MetaAgentPanel";
import { NodeConfigPanel } from "./components/NodeConfigPanel";
import { RunParamsDialog } from "./components/RunParamsDialog";
import { RunStatusPanel } from "./components/RunStatusPanel";
import { TriggerPanel } from "./components/TriggerPanel";
import { VersionPanel } from "./components/VersionPanel";
import { YamlSlidePanel } from "./components/YamlSlidePanel";
import { useWorkflowCanvas } from "./hooks/useWorkflowCanvas";
import { useWorkflowMetaAgent } from "./hooks/useWorkflowMetaAgent";
import { useWorkflowPersistence } from "./hooks/useWorkflowPersistence";
import { useWorkflowRun } from "./hooks/useWorkflowRun";
import { autoLayout } from "./layout";
import { nodeTypes } from "./nodes";
import { dedupEvents } from "./utils";
import { createStartNode, defaultMeta, START_NODE_ID, type WfMeta, yamlToFlow } from "./yaml-utils";
import "./workflow.css";

const PALETTE_ITEMS = [
  { type: "shell", labelKey: "nodes.shell", icon: Terminal, color: "#3b82f6" },
  { type: "python", labelKey: "nodes.python", icon: Code, color: "#0ea5e9" },
  { type: "agent", labelKey: "nodes.agent", icon: Bot, color: "#22c55e" },
  { type: "api", labelKey: "nodes.api", icon: Globe, color: "#8b5cf6" },
  { type: "audit", labelKey: "editor.palette_audit", icon: ShieldCheck, color: "#f59e0b" },
  // { type: "workflow", labelKey: "editor.palette_subworkflow", icon: GitBranch, color: "#ec4899" },
  // { type: "loop", labelKey: "editor.palette_loop", icon: RefreshCw, color: "#06b6d4" },
] as const;

interface WorkflowEditorProps {
  workflowId?: string;
  runId?: string;
}

function WorkflowEditorInner({ workflowId, runId }: WorkflowEditorProps) {
  const { t } = useTranslation("workflows");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([createStartNode()]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView, screenToFlowPosition } = useReactFlow();

  const [meta, setMeta] = useState<WfMeta>({ ...defaultMeta });
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlText, setYamlText] = useState("");
  const [readOnly, setReadOnly] = useState(false);

  // ── 运行模式状态（顶层持有，传给 Run hook） ──
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runSnapshot, setRunSnapshot] = useState<DAGSnapshot | null>(null);
  const [runEvents, setRunEvents] = useState<DAGEvent[]>([]);
  const [runApprovals, setRunApprovals] = useState<PendingApproval[]>([]);
  const [selectedRunNodeId, setSelectedRunNodeId] = useState<string | null>(null);
  const [selectedNodeOutput, setSelectedNodeOutput] = useState<NodeOutput | null>(null);
  const [nodeOutputLoading, setNodeOutputLoading] = useState(false);
  const [rightTab, setRightTab] = useState<"config" | "run" | "versions" | "triggers">("config");
  const [paramsDialogOpen, setParamsDialogOpen] = useState(false);

  // ── Refs ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingConnectSource = useRef<string | null>(null);
  const didConnect = useRef(false);

  // ── Meta Agent Chat ──
  const { scenePrompt, chatOpen, setChatOpen, metaAgentId, agentList, agentOverrideOpen, setAgentOverrideOpen } =
    useWorkflowMetaAgent({ workflowId, meta });

  // ── Persistence hook ──
  const {
    syncYaml,
    handleImportYaml,
    handleExportYaml,
    handleFileImport,
    handleSaveDraft,
    handlePublish,
    saveStatus,
    publishing,
    lastSavedYaml,
    setLastSavedYaml,
  } = useWorkflowPersistence({
    workflowId,
    meta,
    nodes,
    edges,
    setNodes,
    setEdges,
    fitView,
    yamlOpen,
    yamlText,
    setYamlText,
    setSelectedNode,
    setMeta,
    setDryRunResult: () => {}, // placeholder, will be overridden by run hook
    setYamlOpen,
  });

  // ── Canvas hook ──
  const {
    onSelectionChange: canvasOnSelectionChange,
    onConnect,
    onConnectStart,
    onConnectEnd,
    handleNodesDelete,
    addNode,
    onDragOver,
    onDrop,
    handleAutoLayout,
    handleNew,
    updateNodeData,
    handleIdChange,
  } = useWorkflowCanvas({
    nodes,
    edges,
    setNodes,
    setEdges,
    setMeta,
    setSelectedNode,
    readOnly,
    activeRunId,
    selectedNode,
    screenToFlowPosition,
    fitView,
    pendingConnectSource,
    didConnect,
    setDryRunResult: () => {}, // placeholder
    setYamlText,
    setSelectedRunNodeId,
  });

  // ── Run hook ──
  const {
    handleDryRun,
    handleRun,
    handleCancelRun,
    handleApprove,
    handleBackToEdit,
    handleBackToList,
    handleRerunFrom,
    handleRefreshDraft,
    dryRunResult,
    running,
    isRunMode,
    isRunDone,
    dagStatus,
    runRightTab,
    setRunRightTab,
    updateNodesFromSnapshot,
    clearDryRunResult,
    handleWorkflowEvent,
  } = useWorkflowRun({
    workflowId,
    nodes,
    edges,
    setNodes,
    setEdges,
    activeRunId,
    setActiveRunId,
    runSnapshot,
    setRunSnapshot,
    setRunEvents,
    setRunApprovals,
    selectedRunNodeId,
    setSelectedRunNodeId,
    selectedNodeOutput,
    setSelectedNodeOutput,
    nodeOutputLoading,
    setNodeOutputLoading,
    syncYaml,
    fitView,
    rightTab,
    setRightTab,
    setMeta,
    lastSavedYaml,
    setLastSavedYaml,
    meta,
  });

  // ── Workflow SSE 实时事件 ──
  useEffect(() => {
    if (!workflowId) return;

    connectWorkflowSSE(workflowId, (event) => {
      switch (event.type) {
        case "workflow.draft_updated":
          handleRefreshDraft();
          break;
        case "workflow.run_started":
        case "workflow.run_status_changed":
        case "workflow.run_cancelled":
          handleWorkflowEvent(event);
          break;
        case "workflow.dry_run_completed":
        case "workflow.version_published":
          break;
      }
    });

    return () => {
      disconnectWorkflowSSE();
    };
  }, [workflowId, handleRefreshDraft, handleWorkflowEvent]);

  // ── Derived state ──
  const onSelectionChange: OnSelectionChangeFunc = canvasOnSelectionChange;

  // 加载已保存的工作流草稿
  useEffect(() => {
    if (!workflowId) return;
    (async () => {
      try {
        const wf = await workflowDefApi.get(workflowId);
        if (wf.draftYaml) {
          const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
          const laid = autoLayout(newNodes, newEdges);
          setNodes(laid);
          setEdges(newEdges);
          setMeta(newMeta);
          setLastSavedYaml(wf.draftYaml);
          setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
        }
        if (wf.name) setMeta((m) => ({ ...m, name: wf.name }));
        if (wf.description) setMeta((m) => ({ ...m, description: String(wf.description ?? "") }));
      } catch (err) {
        console.error("Failed to load workflow:", err);
      }
    })();
  }, [workflowId, fitView, setEdges, setNodes, setLastSavedYaml]);

  // Load historical run data (point-in-time replay)
  useEffect(() => {
    if (!runId) return;
    let abort = false;
    (async () => {
      try {
        setActiveRunId(runId);
        setRunSnapshot(null);
        setRunEvents([]);
        setRunApprovals([]);
        setSelectedRunNodeId(null);
        setSelectedNodeOutput(null);
        setRightTab("run");

        const [snap, evts] = await Promise.all([
          workflowEngineApi.getRunStatus(runId),
          workflowEngineApi.getEvents(runId),
        ]);
        if (abort) return;
        if (snap) {
          setRunSnapshot(snap);
          updateNodesFromSnapshot(snap);
        }
        if (Array.isArray(evts)) setRunEvents(dedupEvents(evts));
      } catch (err) {
        console.error(`${t("editor.load_run_failed")}:`, err);
      }
    })();
    return () => {
      abort = true;
    };
  }, [runId, t, updateNodesFromSnapshot]);

  // ── Update meta ──
  const updateMeta = useCallback((updates: Partial<WfMeta>) => {
    setMeta((prev) => ({ ...prev, ...updates }));
  }, []);

  // ── Sync meta.params to start node data ──
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => (n.id === START_NODE_ID ? { ...n, data: { ...n.data, _params: meta.params } } : n)),
    );
  }, [meta.params, setNodes]);

  const sd = selectedNode?.data as Record<string, unknown> | undefined;
  const nodeType = selectedNode?.type ?? "shell";

  // ── 运行按钮：检查是否需要参数输入 ──
  const workflowParams = meta.params as Record<string, Record<string, unknown>> | undefined;
  const hasParams = workflowParams && Object.keys(workflowParams).length > 0;

  const onRunClick = useCallback(() => {
    console.log("[RunButton] meta.params:", JSON.stringify(meta.params), "hasParams:", hasParams);
    if (hasParams) {
      setParamsDialogOpen(true);
    } else {
      handleRun();
    }
  }, [hasParams, handleRun, meta.params]);

  const onParamsSubmit = useCallback(
    (values: Record<string, unknown>) => {
      setParamsDialogOpen(false);
      handleRun(values);
    },
    [handleRun],
  );

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
          <Lock size={12} /> {t("editor.readonly_mode")}
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
          onConnectStart={readOnly ? undefined : (onConnectStart as unknown as typeof undefined)}
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
                <div className="wf-palette-title">{t("editor.palette_drag_hint")}</div>
                {PALETTE_ITEMS.map(({ type, labelKey, icon: Icon, color }) => (
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
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            </Panel>
          )}

          {/* 工具栏 */}
          <Panel position="top-center" className="wf-panel-toolbar">
            <div className="wf-toolbar">
              {!readOnly && (
                <button
                  type="button"
                  className="wf-toolbar-btn"
                  onClick={handleNew}
                  data-tooltip={t("editor.tooltip_new")}
                >
                  <FilePlus size={15} />
                </button>
              )}
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={() => fileInputRef.current?.click()}
                data-tooltip={t("editor.tooltip_import")}
              >
                <Upload size={15} />
              </button>
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={handleExportYaml}
                data-tooltip={t("editor.tooltip_export")}
              >
                <Download size={15} />
              </button>
              <div className="wf-toolbar-divider" />
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={handleAutoLayout}
                data-tooltip={t("editor.tooltip_layout")}
              >
                <LayoutGrid size={15} />
              </button>
              {workflowId && (
                <button
                  type="button"
                  className="wf-toolbar-btn"
                  onClick={handleRefreshDraft}
                  disabled={isRunMode && !isRunDone}
                  data-tooltip={t("editor.tooltip_refresh")}
                >
                  <RefreshCw size={15} />
                </button>
              )}
              {workflowId && (
                <>
                  <div className="wf-toolbar-divider" />
                  <button
                    type="button"
                    className="wf-toolbar-btn"
                    onClick={handleSaveDraft}
                    disabled={saveStatus === "saving"}
                    data-tooltip={t("editor.tooltip_save")}
                  >
                    <Save size={15} />
                  </button>
                  <button
                    type="button"
                    className={`wf-toolbar-btn ${rightTab === "versions" ? "active" : ""}`}
                    onClick={() => setRightTab(rightTab === "versions" ? "config" : "versions")}
                    data-tooltip={t("editor.tooltip_versions")}
                  >
                    <Rocket size={15} />
                  </button>
                  <button
                    type="button"
                    className={`wf-toolbar-btn ${rightTab === "triggers" ? "active" : ""}`}
                    onClick={() => setRightTab(rightTab === "triggers" ? "config" : "triggers")}
                    data-tooltip={t("editor.tab_triggers")}
                  >
                    <Link size={15} />
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
                data-tooltip={t("editor.tooltip_yaml")}
              >
                <Code size={15} />
              </button>
              <div className="wf-toolbar-divider" />
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={handleDryRun}
                disabled={running}
                data-tooltip={t("editor.tooltip_validate")}
              >
                <CheckCircle size={15} />
              </button>
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={onRunClick}
                disabled={running}
                data-tooltip={t("editor.tooltip_run")}
                style={running ? { opacity: 0.5 } : undefined}
              >
                <Play size={15} />
              </button>
              <div className="wf-toolbar-divider" />
              <button
                type="button"
                className={`wf-toolbar-btn ${readOnly ? "active" : ""}`}
                onClick={() => setReadOnly(!readOnly)}
                data-tooltip={readOnly ? t("editor.tooltip_readonly_off") : t("editor.tooltip_readonly_on")}
              >
                {readOnly ? <Eye size={15} /> : <Edit3 size={15} />}
              </button>
              <div className="wf-toolbar-divider" />
              <button
                type="button"
                className={`wf-toolbar-btn ${chatOpen ? "active" : ""}`}
                onClick={() => setChatOpen(!chatOpen)}
                data-tooltip={t("editor.tooltip_chat")}
              >
                <MessageSquare size={15} />
              </button>
              <button
                type="button"
                className={`wf-toolbar-btn ${rightTab === "run" ? "active" : ""}`}
                onClick={() => setRightTab(rightTab === "run" ? "config" : "run")}
                data-tooltip={t("editor.tooltip_run_history")}
              >
                <List size={15} />
              </button>
            </div>
          </Panel>
        </ReactFlow>

        {/* 保存状态指示器 */}
        {saveStatus === "saving" && (
          <div
            style={{
              position: "absolute",
              top: 52,
              left: "50%",
              transform: "translateX(-50%)",
              background: "#eff6ff",
              border: "1px solid #93c5fd",
              borderRadius: 8,
              padding: "6px 12px",
              fontSize: 11,
              color: "#1d4ed8",
              zIndex: 10,
            }}
          >
            {t("editor.saving")}
          </div>
        )}
        {saveStatus === "saved" && (
          <div
            style={{
              position: "absolute",
              top: 52,
              left: "50%",
              transform: "translateX(-50%)",
              background: "#f0fdf4",
              border: "1px solid #86efac",
              borderRadius: 8,
              padding: "6px 12px",
              fontSize: 11,
              color: "#166534",
              zIndex: 10,
            }}
          >
            {t("editor.saved")}
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
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontWeight: 600,
                marginBottom: dryRunResult.issues.length ? 4 : 0,
              }}
            >
              {dryRunResult.valid ? <CheckCircle size={13} /> : <AlertTriangle size={13} />}
              {dryRunResult.valid
                ? t("editor.validate_pass")
                : t("editor.validate_fail", { count: dryRunResult.issues.length })}
              <button
                type="button"
                onClick={() => clearDryRunResult()}
                style={{
                  marginLeft: "auto",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  color: "inherit",
                }}
              >
                <X size={12} />
              </button>
            </div>
            {dryRunResult.issues.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {dryRunResult.issues.map((issue, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: issues may duplicate type+message
                  <li key={`${issue.type}-${issue.message}-${i}`}>
                    {issue.type === "error" ? "❌" : "⚠️"} {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* YAML 滑出面板 */}
        <YamlSlidePanel
          yamlOpen={yamlOpen}
          yamlText={yamlText}
          setYamlText={setYamlText}
          setYamlOpen={setYamlOpen}
          readOnly={readOnly}
          handleImportYaml={handleImportYaml}
        />
      </div>

      {/* 右侧统一面板（配置 / 运行 / 版本 tabs） */}
      <aside className="wf-prop-panel" style={{ width: 300, minWidth: 300 }}>
        {/* Tab 头 */}
        <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb" }}>
          {[
            { key: "config" as const, label: t("editor.tab_config") },
            { key: "run" as const, label: t("editor.tab_run") },
            { key: "versions" as const, label: t("editor.tab_versions") },
            { key: "triggers" as const, label: t("editor.tab_triggers") },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setRightTab(tab.key)}
              style={{
                flex: 1,
                padding: "8px 0",
                border: "none",
                background: "none",
                fontSize: 11,
                fontWeight: rightTab === tab.key ? 600 : 400,
                color: rightTab === tab.key ? "#111827" : "#9ca3af",
                borderBottom: rightTab === tab.key ? "2px solid #3b82f6" : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── 配置 Tab ── */}
        {rightTab === "config" && (
          <NodeConfigPanel
            readOnly={readOnly}
            selectedNode={selectedNode}
            sd={sd}
            nodeType={nodeType}
            handleIdChange={handleIdChange}
            setNodes={setNodes}
            setSelectedNode={setSelectedNode}
            updateNodeData={updateNodeData}
            agentList={agentList}
            agentOverrideOpen={agentOverrideOpen}
            setAgentOverrideOpen={setAgentOverrideOpen}
            meta={meta}
            updateMeta={updateMeta}
          />
        )}

        {/* ── 运行 Tab ── */}
        {rightTab === "run" && (
          <RunStatusPanel
            activeRunId={activeRunId}
            runSnapshot={runSnapshot}
            dagStatus={dagStatus}
            isRunMode={isRunMode}
            isRunDone={isRunDone}
            running={running}
            runEvents={runEvents}
            runApprovals={runApprovals}
            runRightTab={runRightTab}
            setRunRightTab={setRunRightTab}
            selectedRunNodeId={selectedRunNodeId}
            setSelectedRunNodeId={setSelectedRunNodeId}
            selectedNodeOutput={selectedNodeOutput}
            nodeOutputLoading={nodeOutputLoading}
            handleCancelRun={handleCancelRun}
            handleBackToEdit={handleBackToEdit}
            handleBackToList={handleBackToList}
            handleApprove={handleApprove}
            handleRerunFrom={handleRerunFrom}
            setActiveRunId={setActiveRunId}
            setRunSnapshot={setRunSnapshot}
            setRunEvents={setRunEvents}
            setRunApprovals={setRunApprovals}
            setSelectedNodeOutput={setSelectedNodeOutput}
            updateNodesFromSnapshot={updateNodesFromSnapshot}
            setRightTab={setRightTab}
          />
        )}

        {/* ── 版本 Tab ── */}
        {rightTab === "versions" && (
          <VersionPanel
            workflowId={workflowId}
            onClose={() => setRightTab("config")}
            onPublish={handlePublish}
            publishing={publishing}
          />
        )}

        {/* ── 触发器 Tab ── */}
        {rightTab === "triggers" && <TriggerPanel workflowId={workflowId} onClose={() => setRightTab("config")} />}
      </aside>

      {/* Meta Agent Chat 侧边栏 */}
      <MetaAgentPanel
        chatOpen={chatOpen}
        setChatOpen={setChatOpen}
        metaAgentId={metaAgentId}
        scenePrompt={scenePrompt}
      />

      {/* 运行参数输入对话框 */}
      {hasParams && (
        <RunParamsDialog
          open={paramsDialogOpen}
          onOpenChange={setParamsDialogOpen}
          // biome-ignore lint/suspicious/noExplicitAny: meta.params is user-defined JSON
          params={workflowParams as any}
          onSubmit={onParamsSubmit}
        />
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
