import { Background, BackgroundVariant, Controls, type Edge, type Node, ReactFlow } from "@xyflow/react";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CustomToolItem } from "../../../api/workflow-defs";
import { edgeTypes } from "../edges";
import { nodeTypes } from "../nodes";
import { EditorToolbar, NodePalettePanel } from "./workflow-editor-canvas-panels";

/**
 * 画布本体：徽标、ReactFlow 的配置、以及画布内两块浮层（节点面板与工具栏）。
 *
 * 抽出来的理由与 §4.7 的「页面 + 数据编排 + 传输适配」同源——编辑器的渲染里有 80 行只是把画布的状态与
 * 回调接到 ReactFlow 的二十几个属性上，与「编辑器持有哪些状态、怎么编排」是两件事。浮层也在本文件里，
 * 因为 `<Panel>` 必须是 `<ReactFlow>` 的子节点，三者的装配口径（只读时隐藏节点面板、禁用连线与拖拽）
 * 是一份决定。
 *
 * 回调类型直接取自 `ReactFlow` 的 props（`onConnectStart` 等社区类型写法特殊，编辑器侧不再重复断言）。
 */
export interface WorkflowEditorCanvasProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: React.ComponentProps<typeof ReactFlow>["onNodesChange"];
  onEdgesChange: React.ComponentProps<typeof ReactFlow>["onEdgesChange"];
  /** 运行中 / 版本预览：隐藏节点面板与新建、禁用拖拽连线与删除键 */
  readOnly: boolean;
  /** 版本预览号，仅用于左上角徽标文案 */
  previewVersion: number | null;
  onNodesDelete: React.ComponentProps<typeof ReactFlow>["onNodesDelete"];
  onNodeClick: React.ComponentProps<typeof ReactFlow>["onNodeClick"];
  onMoveStart: () => void;
  onSelectionChange: React.ComponentProps<typeof ReactFlow>["onSelectionChange"];
  onConnect: React.ComponentProps<typeof ReactFlow>["onConnect"];
  onConnectStart: React.ComponentProps<typeof ReactFlow>["onConnectStart"];
  onConnectEnd: React.ComponentProps<typeof ReactFlow>["onConnectEnd"];
  onDragOver: React.ComponentProps<typeof ReactFlow>["onDragOver"];
  onDrop: React.ComponentProps<typeof ReactFlow>["onDrop"];
  /** 节点面板的自定义工具分区 */
  customTools: CustomToolItem[];
  addNode: React.ComponentProps<typeof NodePalettePanel>["addNode"];
  /** 工具栏 */
  workflowId?: string;
  saveStatus: "idle" | "saving" | "saved" | "unsaved";
  yamlOpen: boolean;
  running: boolean;
  onNew: () => void;
  onAutoLayout: () => void;
  onSaveDraft: () => void;
  onToggleYaml: () => void;
  onDryRun: () => void;
  onRun: () => void;
}

export function WorkflowEditorCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  readOnly,
  previewVersion,
  onNodesDelete,
  onNodeClick,
  onMoveStart,
  onSelectionChange,
  onConnect,
  onConnectStart,
  onConnectEnd,
  onDragOver,
  onDrop,
  customTools,
  addNode,
  workflowId,
  saveStatus,
  yamlOpen,
  running,
  onNew,
  onAutoLayout,
  onSaveDraft,
  onToggleYaml,
  onDryRun,
  onRun,
}: WorkflowEditorCanvasProps) {
  const { t } = useTranslation("workflows");

  return (
    <>
      {previewVersion !== null && (
        <div
          className="wf-readonly-badge"
          style={{ right: 12, borderColor: "#3b82f6", color: "#3b82f6", background: "rgba(239,246,255,0.9)" }}
        >
          {t("editor.vi_preview_mode")} v{previewVersion}
        </div>
      )}
      {readOnly && previewVersion === null && (
        <div className="wf-readonly-badge" style={{ right: 12 }}>
          <Lock size={12} /> {t("editor.readonly_mode")}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={readOnly ? undefined : onNodesChange}
        onEdgesChange={readOnly ? undefined : onEdgesChange}
        onNodesDelete={onNodesDelete}
        onNodeClick={onNodeClick}
        onMoveStart={onMoveStart}
        onSelectionChange={onSelectionChange}
        onConnect={readOnly ? undefined : onConnect}
        onConnectStart={readOnly ? undefined : (onConnectStart as unknown as typeof undefined)}
        onConnectEnd={readOnly ? undefined : onConnectEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        defaultEdgeOptions={{ type: "logic" }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        className={readOnly ? "wf-canvas-readonly" : ""}
      >
        <Controls position="bottom-left" showInteractive={!readOnly} />
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#d1d5db" />

        {/* 节点面板 */}
        {!readOnly && <NodePalettePanel customTools={customTools} addNode={addNode} />}

        {/* 工具栏 */}
        <EditorToolbar
          workflowId={workflowId}
          readOnly={readOnly}
          previewVersion={previewVersion}
          saveStatus={saveStatus}
          yamlOpen={yamlOpen}
          running={running}
          onNew={onNew}
          onAutoLayout={onAutoLayout}
          onSaveDraft={onSaveDraft}
          onToggleYaml={onToggleYaml}
          onDryRun={onDryRun}
          onRun={onRun}
        />
      </ReactFlow>
    </>
  );
}
