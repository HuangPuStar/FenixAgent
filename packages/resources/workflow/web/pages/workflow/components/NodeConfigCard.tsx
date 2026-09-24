import type { Node } from "@xyflow/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CustomToolItem } from "../../../api/workflow-defs";
import type { AgentNodeOption } from "../hooks/useWorkflowAgentOptions";
import type { WfMeta } from "../yaml-utils";
import { START_NODE_ID } from "../yaml-utils";
import { ExpandFieldDialog, type ExpandState } from "./expand-field-dialog";
import { CustomToolNodeFields } from "./node-config-custom-tool-section";
import { EndNodeSection } from "./node-config-end-section";
import { InlineField } from "./node-config-fields";
import {
  AgentNodeFields,
  ApiNodeFields,
  AuditNodeFields,
  LoopNodeFields,
  WorkflowNodeFields,
} from "./node-config-resource-sections";
import { PythonNodeFields, ShellNodeFields } from "./node-config-script-sections";
import { TransformNodeFields } from "./node-config-transform-section";
import { NodeOutputRefDialogs } from "./node-output-ref-dialogs";
import { useNodeOutputRefGuard } from "./use-node-output-ref-guard";
import { WorkflowMetaCard } from "./WorkflowMetaCard";

/**
 * 节点配置卡片的卡片容器（§4.8 已裁定的三容器之一，与 `NodeConfigPopover` / `NodeConfigSheet` 刻意分叉）。
 *
 * 本文件只负责**外壳与装配**：开始节点分支、基本信息与高级配置两个区块、按 `nodeType` 分发到各分区
 * 组件、以及三个弹窗（展开编辑 / 输出字段改名 / 输出字段删除）的挂载点。按类型的字段渲染在
 * `node-config-*-section(s).tsx`，字段外形在 `node-config-fields.tsx`，纯函数在
 * `node-config-model.ts` 与 `node-output-refs-model.ts`，下游引用的确认编排在 `use-node-output-ref-guard.ts`。
 */
export interface NodeConfigCardProps {
  readOnly: boolean;
  selectedNode: Node;
  sd: Record<string, unknown> | undefined;
  nodeType: string;
  handleIdChange: (newId: string) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setSelectedNode: React.Dispatch<React.SetStateAction<Node | null>>;
  updateNodeData: (patch: Record<string, unknown>) => void;
  agentList: AgentNodeOption[];
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
  customTools: CustomToolItem[];
  /** 所有节点，用于检测输出字段改名时扫描下游引用 */
  nodes: Node[];
  /** 当前编辑的工作流 ID，用于 end 节点显示外部 API 调用方式 */
  workflowId?: string;
}

export function NodeConfigCard({
  readOnly,
  selectedNode,
  sd,
  nodeType,
  handleIdChange,
  setNodes,
  setSelectedNode,
  updateNodeData,
  agentList,
  meta,
  updateMeta,
  customTools,
  nodes,
  workflowId,
}: NodeConfigCardProps) {
  const { t } = useTranslation("workflows");
  const isStartNode = selectedNode.id === START_NODE_ID;

  // 展开编辑弹窗的状态（一张卡片共用一个实例，见 expand-field-dialog.tsx）
  const [expand, setExpand] = useState<ExpandState | null>(null);

  // 输出字段改名 / 删除的下游引用确认：弹窗状态与「等待用户点确认」的 Promise 都在 hook 里。
  // 状态留在卡片壳而不是下沉到 custom 分区，是为了让两个弹窗与展开弹窗同级挂在根部——
  // 分区随 nodeType 切换整块重渲，弹窗不该被牵连。
  const outputRefDialogs = useNodeOutputRefGuard({ nodes, nodeId: selectedNode.id, setNodes });

  return (
    <div className="wf-popover-body">
      {/* 开始节点 */}
      {isStartNode ? (
        <WorkflowMetaCard readOnly={readOnly} meta={meta} updateMeta={updateMeta} />
      ) : (
        <>
          {/* 节点基本信息 */}
          <div className="wf-prop-section">
            <div className="wf-prop-section-title">{t("editor.basic_info")}</div>
            <InlineField label={t("editor.node_id")}>
              <input value={selectedNode.id} onChange={(e) => handleIdChange(e.target.value)} readOnly={readOnly} />
            </InlineField>
            <InlineField label={t("editor.type")}>
              <select
                value={nodeType}
                onChange={(e) => {
                  const newType = e.target.value;
                  setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, type: newType } : n)));
                  setSelectedNode((prev) => (prev ? { ...prev, type: newType } : null));
                }}
                disabled={readOnly}
              >
                <option value="shell">{t("editor.type_shell")}</option>
                <option value="python">{t("editor.type_python")}</option>
                <option value="agent">{t("editor.type_agent")}</option>
                <option value="api">{t("editor.type_api")}</option>
                <option value="audit">{t("editor.type_audit")}</option>
                <option value="workflow">{t("editor.type_workflow")}</option>
                <option value="loop">{t("editor.type_loop")}</option>
                <option value="transform">{t("nodes.transform")}</option>
                <option value="custom">{t("editor.type_custom")}</option>
              </select>
            </InlineField>
            <InlineField label={t("editor.description")}>
              <input
                value={String(sd?.description ?? "")}
                onChange={(e) => updateNodeData({ description: e.target.value || undefined })}
                placeholder={t("editor.description_placeholder")}
                readOnly={readOnly}
              />
            </InlineField>
          </div>

          {/* 节点配置（按类型） */}
          <div className="wf-prop-section">
            <div className="wf-prop-section-title">{t("editor.config")}</div>

            {nodeType === "shell" && (
              <ShellNodeFields readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} onExpand={setExpand} />
            )}

            {nodeType === "python" && (
              <PythonNodeFields readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} onExpand={setExpand} />
            )}

            {nodeType === "agent" && (
              <AgentNodeFields
                readOnly={readOnly}
                sd={sd}
                updateNodeData={updateNodeData}
                onExpand={setExpand}
                agentList={agentList}
              />
            )}

            {nodeType === "api" && (
              <ApiNodeFields readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} onExpand={setExpand} />
            )}

            {nodeType === "audit" && (
              <AuditNodeFields readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} onExpand={setExpand} />
            )}

            {nodeType === "workflow" && (
              <WorkflowNodeFields readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} onExpand={setExpand} />
            )}

            {nodeType === "loop" && (
              <LoopNodeFields readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} onExpand={setExpand} />
            )}

            {nodeType === "transform" && (
              <TransformNodeFields readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} />
            )}

            {nodeType === "custom" && (
              <CustomToolNodeFields
                readOnly={readOnly}
                sd={sd}
                updateNodeData={updateNodeData}
                customTools={customTools}
                onOutputRename={outputRefDialogs.handleOutputRename}
                onOutputDelete={outputRefDialogs.handleOutputDelete}
                onExpand={setExpand}
              />
            )}
          </div>

          {/* ── end 节点：inputs 编辑器 + 外部 API 使用方式 ── */}
          {nodeType === "end" && (
            <EndNodeSection
              readOnly={readOnly}
              sd={sd}
              updateNodeData={updateNodeData}
              meta={meta}
              workflowId={workflowId}
            />
          )}

          {/* 高级配置 */}
          <div className="wf-prop-section">
            <div className="wf-prop-section-title">{t("editor.advanced")}</div>
            <InlineField label={t("editor.timeout_seconds")}>
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
            </InlineField>
            <InlineField label={t("editor.retry_count")}>
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
            </InlineField>
          </div>
        </>
      )}

      {/* 代码展开编辑 Dialog */}
      <ExpandFieldDialog expand={expand} readOnly={readOnly} onClose={() => setExpand(null)} />

      <NodeOutputRefDialogs
        renameDialog={outputRefDialogs.renameDialog}
        deleteDialog={outputRefDialogs.deleteDialog}
        onRenameCancel={outputRefDialogs.cancelRename}
        onRenameConfirm={outputRefDialogs.confirmRename}
        onDeleteCancel={outputRefDialogs.cancelDeleteOutput}
        onDeleteConfirm={outputRefDialogs.confirmDeleteOutput}
      />
    </div>
  );
}
