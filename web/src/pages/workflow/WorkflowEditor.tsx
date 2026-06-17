import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type Node,
  type OnSelectionChangeFunc,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import "@xyflow/react/dist/style.css";
import {
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
} from "lucide-react";
import { MetaAgentPanel } from "@/components/MetaAgentPanel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useContextQueue } from "@/src/lib/use-context-queue";
import { type WorkflowDefItem, workflowDefApi } from "../../api/workflow-defs";
import {
  type DAGEvent,
  type DAGSnapshot,
  type NodeOutput,
  type PendingApproval,
  workflowEngineApi,
} from "../../api/workflow-engine";
import { connectWorkflowSSE, disconnectWorkflowSSE } from "../../api/workflow-sse";
import { NodeConfigPopover } from "./components/NodeConfigPopover";
import { RunParamsDialog } from "./components/RunParamsDialog";
import { RunStatusPanel } from "./components/RunStatusPanel";
import { TriggerPanel } from "./components/TriggerPanel";
import { VersionIndicator } from "./components/VersionIndicator";
import { VersionPanel } from "./components/VersionPanel";
import { WorkflowMetaPopover } from "./components/WorkflowMetaPopover";
import { YamlSlidePanel } from "./components/YamlSlidePanel";
import { edgeTypes } from "./edges";
import { useWorkflowCanvas } from "./hooks/useWorkflowCanvas";
import { useWorkflowMetaAgent } from "./hooks/useWorkflowMetaAgent";
import { useWorkflowPersistence } from "./hooks/useWorkflowPersistence";
import { useWorkflowRun } from "./hooks/useWorkflowRun";
import { autoLayout } from "./layout";
import { nodeTypes } from "./nodes";
import { TRANSFORM_PRESETS } from "./presets";
import { dedupEvents } from "./utils";
import { createStartNode, defaultMeta, START_NODE_ID, type WfMeta, yamlToFlow } from "./yaml-utils";
import "./workflow.css";

const BASIC_PALETTE_ITEMS = [
  { type: "shell", labelKey: "nodes.shell", icon: Terminal, color: "#3b82f6" },
  { type: "python", labelKey: "nodes.python", icon: Code, color: "#0ea5e9" },
  { type: "agent", labelKey: "nodes.agent", icon: Bot, color: "#22c55e" },
  { type: "api", labelKey: "nodes.api", icon: Globe, color: "#8b5cf6" },
  { type: "audit", labelKey: "editor.palette_audit", icon: ShieldCheck, color: "#f59e0b" },
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
  const [yamlBaseText, setYamlBaseText] = useState("");
  const [readOnly, setReadOnly] = useState(false);

  // ── 版本预览状态 ──
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [wfData, setWfData] = useState<WorkflowDefItem | null>(null);

  // ── 运行模式状态（顶层持有，传给 Run hook） ──
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runSnapshot, setRunSnapshot] = useState<DAGSnapshot | null>(null);
  const [runEvents, setRunEvents] = useState<DAGEvent[]>([]);
  const [runApprovals, setRunApprovals] = useState<PendingApproval[]>([]);
  const [selectedRunNodeId, setSelectedRunNodeId] = useState<string | null>(null);
  const [selectedNodeOutput, setSelectedNodeOutput] = useState<NodeOutput | null>(null);
  const [nodeOutputLoading, setNodeOutputLoading] = useState(false);
  const [runSheetOpen, setRunSheetOpen] = useState(false);
  const [versionsSheetOpen, setVersionsSheetOpen] = useState(false);
  const [triggersSheetOpen, setTriggersSheetOpen] = useState(false);
  const [paramsDialogOpen, setParamsDialogOpen] = useState(false);

  // ── Popover 状态 ──
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [metaPopoverOpen, setMetaPopoverOpen] = useState(false);

  // ── Refs ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingConnectSource = useRef<string | null>(null);
  const didConnect = useRef(false);
  const setDryRunResultRef = useRef<
    (result: { valid: boolean; issues: Array<{ type: string; message: string; field?: string }> } | null) => void
  >(() => {});

  // ── Meta Agent Chat ──
  const selectedNodeInfo = useMemo(() => {
    if (!selectedNode) return null;
    return { id: selectedNode.id, type: selectedNode.type ?? "unknown" };
  }, [selectedNode?.id, selectedNode?.type, selectedNode]);

  const { scenePrompt, contextKey, chatOpen, setChatOpen, metaAgentId, agentList } = useWorkflowMetaAgent({
    workflowId,
    meta,
    selectedNodeInfo,
  });

  // 将当前编辑器上下文推入 Context Queue，每次消息发送时 agent 可感知
  const editorContextText = useMemo(() => {
    const lines = ["[Workflow Editor Context]"];
    lines.push(`- ${t("editor.workflow_name")}: ${meta.name || t("editor.workflow_unnamed")}`);
    if (selectedNodeInfo) {
      lines.push(`- ${t("editor.selected_node")}: ${selectedNodeInfo.id} (type: ${selectedNodeInfo.type})`);
    }
    return lines.join("\n");
  }, [meta.name, selectedNodeInfo, t]);

  useContextQueue("workflow-editor-context", editorContextText);

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
    hasUnsavedChanges,
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
    setDryRunResult: (r) => setDryRunResultRef.current(r),
    setYamlOpen,
    readOnly: readOnly || activeRunId !== null || previewVersion !== null,
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
    readOnly: readOnly || activeRunId !== null || previewVersion !== null,
    activeRunId,
    selectedNode,
    screenToFlowPosition,
    fitView,
    pendingConnectSource,
    didConnect,
    setDryRunResult: (r) => setDryRunResultRef.current(r),
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
    setDryRunResult,
    running,
    isRunMode,
    isRunDone,
    dagStatus,
    runRightTab,
    setRunRightTab,
    updateNodesFromSnapshot,
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
    openRunSheet: () => {
      setRunSheetOpen(true);
      setVersionsSheetOpen(false);
      setTriggersSheetOpen(false);
    },
    setMeta,
    lastSavedYaml,
    setLastSavedYaml,
    meta,
  });

  // 将真正的 setDryRunResult 注入 ref，供 persistence/canvas hook 使用
  useEffect(() => {
    setDryRunResultRef.current = setDryRunResult;
  });

  // ── 运行模式/版本预览下画布自动只读 ──
  const effectiveReadOnly = readOnly || isRunMode || previewVersion !== null;

  // ── 保存状态 toast ──
  useEffect(() => {
    if (saveStatus === "saved") {
      toast.success(t("editor.saved"), { duration: 1500 });
    }
  }, [saveStatus, t]);

  // ── DryRun 结果 toast ──
  useEffect(() => {
    if (!dryRunResult) return;
    if (dryRunResult.valid) {
      toast.success(t("editor.validate_pass"), { duration: 2000 });
    } else {
      toast.error(t("editor.validate_fail", { count: dryRunResult.issues.length }), {
        description: dryRunResult.issues.map((i) => `${i.type === "error" ? "❌" : "⚠️"} ${i.message}`).join("\n"),
        duration: 5000,
      });
    }
  }, [dryRunResult, t]);

  // ── Workflow SSE 实时事件 ──
  useEffect(() => {
    if (!workflowId) return;

    connectWorkflowSSE(workflowId, (event) => {
      switch (event.type) {
        case "workflow.draft_updated":
          if (!hasUnsavedChanges && previewVersion === null) {
            handleRefreshDraft();
          }
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
  }, [workflowId, handleRefreshDraft, handleWorkflowEvent, hasUnsavedChanges, previewVersion]);

  // ── Derived state ──
  const onSelectionChange: OnSelectionChangeFunc = canvasOnSelectionChange;

  // ── 节点点击处理 ──
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (isRunMode) {
        setSelectedNode(node);
        return;
      }
      if (selectedNode?.id === node.id && popoverOpen) {
        setPopoverOpen(false);
        setSelectedNode(null);
      } else {
        setSelectedNode(node);
        setPopoverOpen(true);
      }
    },
    [popoverOpen, selectedNode, isRunMode],
  );

  // ── 画布移动时关闭 popover ──
  const handleMoveStart = useCallback(() => {
    if (popoverOpen) {
      setPopoverOpen(false);
      setSelectedNode(null);
    }
  }, [popoverOpen]);

  // 加载已保存的工作流草稿
  useEffect(() => {
    if (!workflowId) return;
    // workflowId 切换时清理所有旧状态
    setPreviewVersion(null);
    setActiveRunId(null);
    setRunSnapshot(null);
    setRunEvents([]);
    setRunApprovals([]);
    setSelectedRunNodeId(null);
    setSelectedNodeOutput(null);
    setPopoverOpen(false);
    setSelectedNode(null);
    setYamlOpen(false);
    setRunSheetOpen(false);
    setVersionsSheetOpen(false);
    setTriggersSheetOpen(false);
    (async () => {
      try {
        const wf = await workflowDefApi.get(workflowId);
        setWfData(wf);
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
        setRunSheetOpen(true);

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

  // ── 版本预览：切换到指定版本 ──
  const handlePreviewVersion = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      try {
        const result = await workflowDefApi.getVersion(workflowId, version);
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(result.yaml);
        const laid = autoLayout(newNodes, newEdges);
        setNodes(laid);
        setEdges(newEdges);
        setMeta(newMeta);
        setYamlText(result.yaml);
        setYamlBaseText(result.yaml);
        setPreviewVersion(version);
        setSelectedNode(null);
        setPopoverOpen(false);
        setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
      } catch (err) {
        console.error("Failed to preview version:", err);
        toast.error(t("editor.load_failed"));
      }
    },
    [workflowId, setNodes, setEdges, fitView, t],
  );

  // ── 版本预览：切回草稿 ──
  const handleBackToDraft = useCallback(async () => {
    if (!workflowId) return;
    try {
      const wf = await workflowDefApi.get(workflowId);
      setWfData(wf);
      if (wf.draftYaml) {
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
        const laid = autoLayout(newNodes, newEdges);
        setNodes(laid);
        setEdges(newEdges);
        setMeta(newMeta);
        setLastSavedYaml(wf.draftYaml);
      }
      setPreviewVersion(null);
      setSelectedNode(null);
      setPopoverOpen(false);
      setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
    } catch (err) {
      console.error("Failed to load draft:", err);
      toast.error(t("editor.load_failed"));
    }
  }, [workflowId, setNodes, setEdges, setLastSavedYaml, fitView, t]);

  return (
    <div className="flex w-full h-full bg-surface-0">
      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml"
        onChange={handleFileImport}
        style={{ display: "none" }}
      />

      {/* Meta Agent Chat 左侧面板 */}
      <MetaAgentPanel
        chatOpen={chatOpen}
        setChatOpen={setChatOpen}
        metaAgentId={metaAgentId}
        scenePrompt={scenePrompt}
        contextKey={contextKey}
        onPromptComplete={handleRefreshDraft}
      />
      <div className="flex-1 relative overflow-hidden">
        {previewVersion !== null && (
          <div
            className="wf-readonly-badge"
            style={{ right: 12, borderColor: "#3b82f6", color: "#3b82f6", background: "rgba(239,246,255,0.9)" }}
          >
            {t("editor.vi_preview_mode")} v{previewVersion}
          </div>
        )}
        {effectiveReadOnly && previewVersion === null && (
          <div className="wf-readonly-badge" style={{ right: 12 }}>
            <Lock size={12} /> {t("editor.readonly_mode")}
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={effectiveReadOnly ? undefined : onNodesChange}
          onEdgesChange={effectiveReadOnly ? undefined : onEdgesChange}
          onNodesDelete={(deleted) => {
            handleNodesDelete(deleted);
            if (selectedNode && deleted.some((n) => n.id === selectedNode.id)) {
              setPopoverOpen(false);
              setSelectedNode(null);
            }
          }}
          onNodeClick={handleNodeClick}
          onMoveStart={handleMoveStart}
          onSelectionChange={onSelectionChange}
          onConnect={effectiveReadOnly ? undefined : onConnect}
          onConnectStart={effectiveReadOnly ? undefined : (onConnectStart as unknown as typeof undefined)}
          onConnectEnd={effectiveReadOnly ? undefined : onConnectEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={!effectiveReadOnly}
          nodesConnectable={!effectiveReadOnly}
          elementsSelectable
          deleteKeyCode={effectiveReadOnly ? null : "Delete"}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          defaultEdgeOptions={{ type: "logic" }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          className={effectiveReadOnly ? "wf-canvas-readonly" : ""}
        >
          <Controls position="bottom-left" showInteractive={!effectiveReadOnly} />
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#d1d5db" />

          {/* 节点面板 */}
          {!effectiveReadOnly && (
            <Panel position="top-left" className="wf-panel-palette">
              <div className="wf-palette">
                <div className="wf-palette-title">{t("editor.palette_drag_hint")}</div>
                {/* 基础节点 */}
                {BASIC_PALETTE_ITEMS.map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    className="wf-palette-btn"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/workflow-node", item.type);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => addNode(item.type)}
                  >
                    <span className="wf-palette-icon" style={{ background: item.color }}>
                      <item.icon size={14} />
                    </span>
                    {t(item.labelKey)}
                  </button>
                ))}
                {/* 分隔线 */}
                <div className="wf-palette-divider" />
                {/* 数据变换预设 */}
                {TRANSFORM_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="wf-palette-btn"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/workflow-node", "transform");
                      e.dataTransfer.setData("application/workflow-preset", preset.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => addNode("transform", preset.id)}
                  >
                    <span className="wf-palette-icon" style={{ background: preset.color }}>
                      <preset.icon size={14} />
                    </span>
                    {t(preset.labelKey)}
                  </button>
                ))}
              </div>
            </Panel>
          )}

          {/* 工具栏 */}
          <Panel position="top-center" className="wf-panel-toolbar">
            <div className="wf-toolbar">
              {!effectiveReadOnly && (
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
                    className={`wf-toolbar-btn ${saveStatus === "unsaved" ? "text-amber-500" : ""}`}
                    onClick={handleSaveDraft}
                    disabled={saveStatus === "saving" || previewVersion !== null}
                    data-tooltip={
                      saveStatus === "saving"
                        ? t("editor.saving")
                        : saveStatus === "unsaved"
                          ? t("editor.tooltip_save_unsaved")
                          : t("editor.tooltip_save")
                    }
                  >
                    {saveStatus === "saving" ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}
                  </button>
                  <button
                    type="button"
                    className={`wf-toolbar-btn ${versionsSheetOpen ? "active" : ""}`}
                    onClick={() => {
                      setVersionsSheetOpen(!versionsSheetOpen);
                      if (!versionsSheetOpen) {
                        setRunSheetOpen(false);
                        setTriggersSheetOpen(false);
                      }
                    }}
                    data-tooltip={t("editor.tooltip_versions")}
                  >
                    <Rocket size={15} />
                  </button>
                  <button
                    type="button"
                    className={`wf-toolbar-btn ${triggersSheetOpen ? "active" : ""}`}
                    onClick={() => {
                      setTriggersSheetOpen(!triggersSheetOpen);
                      if (!triggersSheetOpen) {
                        setRunSheetOpen(false);
                        setVersionsSheetOpen(false);
                      }
                    }}
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
                  if (!yamlOpen) {
                    const y = syncYaml();
                    setYamlBaseText(y);
                  }
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
            </div>
          </Panel>
        </ReactFlow>

        {/* YAML 滑出面板 */}
        <YamlSlidePanel
          yamlOpen={yamlOpen}
          yamlText={yamlText}
          setYamlText={setYamlText}
          setYamlOpen={setYamlOpen}
          readOnly={effectiveReadOnly}
          handleImportYaml={handleImportYaml}
          syncYaml={syncYaml}
          hasEdits={yamlOpen && yamlText !== yamlBaseText}
        />

        {/* 节点配置 Popover */}
        <NodeConfigPopover
          open={popoverOpen}
          onOpenChange={(open) => {
            setPopoverOpen(open);
            if (!open) setSelectedNode(null);
          }}
          selectedNode={selectedNode}
          sd={sd}
          nodeType={nodeType}
          readOnly={effectiveReadOnly}
          handleIdChange={handleIdChange}
          setNodes={setNodes}
          setSelectedNode={setSelectedNode}
          updateNodeData={updateNodeData}
          agentList={agentList}
        />

        {/* 右下角按钮组 */}
        <div className="wf-bottom-actions">
          {/* 工作流元数据 Popover（齿轮） */}
          <WorkflowMetaPopover
            open={metaPopoverOpen}
            onOpenChange={setMetaPopoverOpen}
            readOnly={effectiveReadOnly}
            meta={meta}
            updateMeta={updateMeta}
          />

          {/* 运行日志 Popover */}
          <Popover open={runSheetOpen} onOpenChange={setRunSheetOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`wf-meta-trigger-btn ${runSheetOpen ? "active" : ""}`}
                title={t("editor.tooltip_run_history")}
              >
                <List size={14} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="end"
              sideOffset={8}
              collisionPadding={16}
              className="wf-meta-popover"
              style={{ width: 360, maxHeight: 520 }}
            >
              <div className="wf-popover-header">
                <span className="wf-popover-title">{t("editor.run_history")}</span>
              </div>
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
                handleBackToEdit={() => {
                  handleBackToEdit();
                  setRunSheetOpen(false);
                }}
                handleBackToList={() => {
                  handleBackToList();
                  setRunSheetOpen(false);
                }}
                handleApprove={handleApprove}
                handleRerunFrom={handleRerunFrom}
                setActiveRunId={setActiveRunId}
                setRunSnapshot={setRunSnapshot}
                setRunEvents={setRunEvents}
                setRunApprovals={setRunApprovals}
                setSelectedNodeOutput={setSelectedNodeOutput}
                updateNodesFromSnapshot={updateNodesFromSnapshot}
                setRightTab={() => setRunSheetOpen(false)}
              />
            </PopoverContent>
          </Popover>

          {/* 版本指示器（最右侧） */}
          <VersionIndicator
            workflowId={workflowId}
            latestVersion={wfData?.latestVersion ?? null}
            previewVersion={previewVersion}
            onPreview={handlePreviewVersion}
            onBackToDraft={handleBackToDraft}
            onViewAll={() => {
              setVersionsSheetOpen(true);
              setRunSheetOpen(false);
              setTriggersSheetOpen(false);
            }}
          />
        </div>
      </div>

      {/* 版本管理 Sheet */}
      <Sheet open={versionsSheetOpen} onOpenChange={setVersionsSheetOpen}>
        <SheetContent side="right" style={{ width: 360, maxWidth: 360, padding: 0 }}>
          <SheetHeader>
            <SheetTitle>{t("editor.version_management")}</SheetTitle>
          </SheetHeader>
          <div className="wf-sheet-body">
            <VersionPanel
              workflowId={workflowId}
              onClose={() => setVersionsSheetOpen(false)}
              onPublish={handlePublish}
              publishing={publishing}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* 触发器 Sheet */}
      <Sheet open={triggersSheetOpen} onOpenChange={setTriggersSheetOpen}>
        <SheetContent side="right" style={{ width: 360, maxWidth: 360, padding: 0 }}>
          <SheetHeader>
            <SheetTitle>{t("editor.trigger_title")}</SheetTitle>
          </SheetHeader>
          <div className="wf-sheet-body">
            <TriggerPanel workflowId={workflowId} onClose={() => setTriggersSheetOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

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
