import {
  type Edge,
  type Node,
  type OnSelectionChangeFunc,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import type { WorkflowDefItem } from "../../api/workflow-defs";
import type { DAGEvent, DAGSnapshot, NodeOutput, PendingApproval } from "../../api/workflow-engine";
import { NodeConfigSheet } from "./components/NodeConfigSheet";
import { RunStatusPanel } from "./components/RunStatusPanel";
import { WorkflowEditorBottomActions } from "./components/workflow-editor-bottom-actions";
import { WorkflowEditorCanvas } from "./components/workflow-editor-canvas";
import { WorkflowEditorOverlays } from "./components/workflow-editor-overlays";
import { YamlSlidePanel } from "./components/YamlSlidePanel";
import { useWorkflowCustomTools } from "./hooks/use-workflow-custom-tools";
import { useWorkflowDraft } from "./hooks/use-workflow-draft";
import { useWorkflowEditorEvents } from "./hooks/use-workflow-editor-events";
import { useWorkflowNodeInteractions } from "./hooks/use-workflow-node-interactions";
import { useWorkflowRunParams } from "./hooks/use-workflow-run-params";
import { useWorkflowAgentOptions } from "./hooks/useWorkflowAgentOptions";
import { useWorkflowCanvas } from "./hooks/useWorkflowCanvas";
import { useWorkflowPersistence } from "./hooks/useWorkflowPersistence";
import { useWorkflowRun } from "./hooks/useWorkflowRun";
import { isTerminalDagStatus } from "./run-canvas-model";
import { type RunViewSetters, resetRunView } from "./run-view";
import { createStartNode, defaultMeta, START_NODE_ID, type WfMeta } from "./yaml-utils";
import "./workflow.css";

/**
 * 工作流编辑器（§4.8 拆分后的外壳）。
 *
 * 本文件只做三件事：**持有状态**（画布节点与边、元数据、选中节点、YAML 面板、运行视图态、各浮层开关）、
 * **装配 hook**、**拼装渲染**（画布、两个面板、各浮层）。拆出去的部分：
 * - 画布本体与画布内浮层、右下角动作组、各浮层：`components/workflow-editor-{canvas,canvas-panels,bottom-actions,overlays}.tsx`；
 * - 草稿与版本预览命令：`hooks/use-workflow-draft.ts`；节点交互：`hooks/use-workflow-node-interactions.ts`；
 * - SSE、提示与调试快捷键：`hooks/use-workflow-editor-events.ts`；工具注册表：`hooks/use-workflow-custom-tools.ts`；
 * - 运行视图编排：`hooks/useWorkflowRun.ts`（其下再分传输层、生命周期命令与纯模型）。
 *
 * 状态归属：所有 useState 都在本组件（含 `dryRunResult`——它由运行域写入、由本组件的渲染与 SSE 提示读取，
 * 放在顶层就不必再为「声明顺序」造一个 ref 中转），hook 只按 §3.4 的口径读写。运行视图态尤其如此，
 * `RunStatusPanel` 也要直接写它们。
 */
interface WorkflowEditorProps {
  workflowId?: string;
  runId?: string;
}

function WorkflowEditorInner({ workflowId, runId }: WorkflowEditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([createStartNode()]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView, screenToFlowPosition } = useReactFlow();

  const [meta, setMeta] = useState<WfMeta>({ ...defaultMeta });
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlText, setYamlText] = useState("");
  const [yamlBaseText, setYamlBaseText] = useState("");

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
  const [dryRunResult, setDryRunResult] = useState<{
    valid: boolean;
    issues: Array<{ type: string; message: string; field?: string }>;
  } | null>(null);

  // 运行视图态的 setter 打包一次，供下面两处复位共用（定义与理由见 ./run-view.ts）。
  // 依赖为空：5 个 setter 都是 useState 的稳定 setter，打包结果在组件生命周期内不变。
  const runViewSetters: RunViewSetters = useMemo(
    () => ({ setRunSnapshot, setRunEvents, setRunApprovals, setSelectedRunNodeId, setSelectedNodeOutput }),
    [],
  );
  const [runSheetOpen, setRunSheetOpen] = useState(false);
  const [versionsSheetOpen, setVersionsSheetOpen] = useState(false);
  const [triggersSheetOpen, setTriggersSheetOpen] = useState(false);
  // 节点删除确认：与 popover 解耦，避免 popover outside-click 关闭时
  // 把 ConfirmDialog 一起卸载（之前的版本点了 Trash 弹窗就闪没）
  const [deleteConfirmNodeId, setDeleteConfirmNodeId] = useState<string | null>(null);

  // ── Popover 状态 ──
  const [nodeConfigSheetOpen, setNodeConfigSheetOpen] = useState(false);
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);

  // ── Refs ──
  const pendingConnectSource = useRef<string | null>(null);
  const pendingConnectHandleId = useRef<string | null>(null);
  const didConnect = useRef(false);

  const agentList = useWorkflowAgentOptions();
  const customTools = useWorkflowCustomTools();

  // 运行完成后画布自动退出只读模式（runSnapshot 顶层已有，无需等 useWorkflowRun）
  const isRunDone = isTerminalDagStatus(runSnapshot?.dag_status);
  const forceReadOnly = activeRunId !== null && !isRunDone;

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
    setDryRunResult,
    setYamlOpen,
    readOnly: forceReadOnly || previewVersion !== null,
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
    readOnly: forceReadOnly || previewVersion !== null,
    activeRunId,
    selectedNode,
    screenToFlowPosition,
    fitView,
    pendingConnectSource,
    pendingConnectHandleId,
    didConnect,
    setDryRunResult,
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
    running,
    isRunMode,
    dagStatus,
    runRightTab,
    setRunRightTab,
    updateNodesFromSnapshot,
    handleWorkflowEvent,
  } = useWorkflowRun({
    workflowId,
    runId,
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
    setRunSheetOpen,
    setMeta,
    lastSavedYaml,
    setLastSavedYaml,
    setDryRunResult,
    meta,
  });

  // ── Draft hook（草稿加载与版本预览命令；状态仍在本组件） ──
  const { loadDraft, handlePreviewVersion, handleBackToDraft } = useWorkflowDraft({
    workflowId,
    setNodes,
    setEdges,
    setMeta,
    setLastSavedYaml,
    fitView,
    setSelectedNode,
    setNodeConfigSheetOpen,
    setYamlText,
    setYamlBaseText,
    setWfData,
    setPreviewVersion,
  });

  // ── 节点交互（点选 / 移动 / 删除） ──
  const { handleNodeClick, handleMoveStart, handleDeleteNode } = useWorkflowNodeInteractions({
    isRunMode,
    selectedNode,
    nodeConfigSheetOpen,
    setSelectedNode,
    setNodeConfigSheetOpen,
    setSelectedRunNodeId,
    setNodes,
    setEdges,
  });

  // ── SSE、保存状态与 dry-run 提示、调试快捷键 ──
  useWorkflowEditorEvents({
    workflowId,
    saveStatus,
    dryRunResult,
    hasUnsavedChanges,
    previewVersion,
    onDraftUpdated: handleRefreshDraft,
    onWorkflowEvent: handleWorkflowEvent,
  });

  // ── 运行模式/版本预览下画布自动只读 ──
  const effectiveReadOnly = (isRunMode && !isRunDone) || previewVersion !== null;
  const onSelectionChange: OnSelectionChangeFunc = canvasOnSelectionChange;

  // 切换工作流：清理所有旧状态后重新加载草稿。复位的是**编辑器的壳态**（浮层、选中项、运行视图），
  // 草稿本身由 use-workflow-draft 负责，两边都在这一个时机落下。
  useEffect(() => {
    if (!workflowId) return;
    setActiveRunId(null);
    resetRunView(runViewSetters);
    setNodeConfigSheetOpen(false);
    setSelectedNode(null);
    setYamlOpen(false);
    setRunSheetOpen(false);
    setVersionsSheetOpen(false);
    setTriggersSheetOpen(false);
    loadDraft();
  }, [workflowId, loadDraft, runViewSetters]);

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

  // ── 运行按钮的参数入口（声明了 params 就先弹对话框） ──
  const { workflowParams, hasParams, paramsDialogOpen, setParamsDialogOpen, onRunClick, onParamsSubmit } =
    useWorkflowRunParams({ meta, handleRun });

  return (
    <div className="flex w-full h-full bg-surface-0">
      <div className="flex-1 relative overflow-hidden">
        <WorkflowEditorCanvas
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          readOnly={effectiveReadOnly}
          previewVersion={previewVersion}
          onNodesDelete={(deleted) => {
            handleNodesDelete(deleted);
            if (selectedNode && deleted.some((n) => n.id === selectedNode.id)) {
              setNodeConfigSheetOpen(false);
              setSelectedNode(null);
            }
          }}
          onNodeClick={handleNodeClick}
          onMoveStart={handleMoveStart}
          onSelectionChange={onSelectionChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
          customTools={customTools}
          addNode={addNode}
          workflowId={workflowId}
          saveStatus={saveStatus}
          yamlOpen={yamlOpen}
          running={running}
          onNew={handleNew}
          onAutoLayout={handleAutoLayout}
          onSaveDraft={handleSaveDraft}
          onToggleYaml={() => {
            if (!yamlOpen) {
              const y = syncYaml();
              setYamlBaseText(y);
            }
            setYamlOpen(!yamlOpen);
          }}
          onDryRun={handleDryRun}
          onRun={onRunClick}
        />

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

        {/* 节点配置 Sheet */}
        <NodeConfigSheet
          open={nodeConfigSheetOpen}
          onOpenChange={(open) => {
            setNodeConfigSheetOpen(open);
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
          onDeleteRequest={setDeleteConfirmNodeId}
          meta={meta}
          updateMeta={updateMeta}
          customTools={customTools}
          nodes={nodes}
          workflowId={workflowId}
        />

        {/* 右下角按钮组 */}
        <WorkflowEditorBottomActions
          workflowId={workflowId}
          readOnly={effectiveReadOnly}
          previewVersion={previewVersion}
          latestVersion={wfData?.latestVersion ?? null}
          publishing={publishing}
          isRunMode={isRunMode}
          isRunDone={isRunDone}
          runSheetOpen={runSheetOpen}
          meta={meta}
          updateMeta={updateMeta}
          handleFileImport={handleFileImport}
          handleExportYaml={handleExportYaml}
          onToggleRunSheet={() => setRunSheetOpen((prev) => !prev)}
          onViewAllVersions={() => {
            setVersionsSheetOpen(true);
            setRunSheetOpen(false);
            setTriggersSheetOpen(false);
          }}
          onPreviewVersion={handlePreviewVersion}
          onBackToDraft={handleBackToDraft}
          onPublishRequest={() => setPublishConfirmOpen(true)}
          onRefreshDraft={handleRefreshDraft}
        />
      </div>

      <WorkflowEditorOverlays
        workflowId={workflowId}
        versionsSheetOpen={versionsSheetOpen}
        setVersionsSheetOpen={setVersionsSheetOpen}
        triggersSheetOpen={triggersSheetOpen}
        setTriggersSheetOpen={setTriggersSheetOpen}
        handlePublish={handlePublish}
        publishing={publishing}
        hasParams={hasParams}
        paramsDialogOpen={paramsDialogOpen}
        setParamsDialogOpen={setParamsDialogOpen}
        // biome-ignore lint/suspicious/noExplicitAny: meta.params is user-defined JSON
        params={workflowParams as any}
        onParamsSubmit={onParamsSubmit}
        deleteConfirmNodeId={deleteConfirmNodeId}
        setDeleteConfirmNodeId={setDeleteConfirmNodeId}
        handleDeleteNode={handleDeleteNode}
        publishConfirmOpen={publishConfirmOpen}
        setPublishConfirmOpen={setPublishConfirmOpen}
        latestVersion={wfData?.latestVersion ?? null}
      />

      {/* 运行记录侧栏：原 List 按钮触发的 Popover 已统一到这里。
          - isRunMode=true 强制显示，避免运行情况被画布遮挡或弹到角落浮窗看不见
          - 非 run mode 时由 List 按钮 toggle（runSheetOpen）控制，显示历史 run 列表 */}
      {(runSheetOpen || isRunMode) && (
        <aside className="wf-run-panel">
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
            handleBackToList={handleBackToList}
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
        </aside>
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
