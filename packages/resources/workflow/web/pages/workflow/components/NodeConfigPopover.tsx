import type { Node } from "@xyflow/react";
import { Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

type Measurable = { getBoundingClientRect(): DOMRect };

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { CustomToolItem } from "../../../api/workflow-defs";
import type { AgentNodeOption } from "../hooks/useWorkflowMetaAgent";
import type { WfMeta } from "../yaml-utils";
import { START_NODE_ID } from "../yaml-utils";
import { NodeConfigCard } from "./NodeConfigCard";

export interface NodeConfigPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedNode: Node | null;
  sd: Record<string, unknown> | undefined;
  nodeType: string;
  readOnly: boolean;
  handleIdChange: (newId: string) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setSelectedNode: React.Dispatch<React.SetStateAction<Node | null>>;
  updateNodeData: (patch: Record<string, unknown>) => void;
  agentList: AgentNodeOption[];
  /**
   * 用户点击删除按钮时触发；只通知"请求删除"，由父组件负责
   * 弹 ConfirmDialog 确认后再实际删除。把确认弹窗提到父级是为了
   * 避免它被 popover 的 outside-click 关闭逻辑连带卸载。
   */
  onDeleteRequest: (nodeId: string) => void;
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
  customTools: CustomToolItem[];
  /** 所有节点，透传给 NodeConfigCard 用于输出字段改名/删除时扫描下游引用 */
  nodes: Node[];
  /** 当前编辑的工作流 ID，透传给 NodeConfigCard 用于 end 节点显示外部 API 调用方式 */
  workflowId?: string;
}

export function NodeConfigPopover({
  open,
  onOpenChange,
  selectedNode,
  sd,
  nodeType,
  readOnly,
  handleIdChange,
  setNodes,
  setSelectedNode,
  updateNodeData,
  agentList,
  onDeleteRequest,
  meta,
  updateMeta,
  customTools,
  nodes,
  workflowId,
}: NodeConfigPopoverProps) {
  const { t } = useTranslation("workflows");
  const anchorRef = useRef<Measurable>(null!);

  useEffect(() => {
    if (selectedNode) {
      anchorRef.current = document.querySelector(`[data-node-id="${selectedNode.id}"]`)!;
    }
  }, [selectedNode]);

  if (!selectedNode) return null;

  // 开始节点是工作流入口，禁止删除；readOnly / preview 模式下也禁用
  const isStartNode = selectedNode.id === START_NODE_ID;
  const canDelete = !readOnly && !isStartNode;

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent side="right" align="start" sideOffset={8} collisionPadding={16} className="wf-node-popover">
        <div className="wf-popover-header">
          <span className="wf-popover-title">{isStartNode ? t("editor.workflow_settings") : selectedNode.id}</span>
          <span className="wf-popover-type">{t(`nodes.${nodeType}`)}</span>
          {canDelete && (
            <button
              type="button"
              onClick={() => onDeleteRequest(selectedNode.id)}
              title={t("editor.delete_node_tooltip")}
              aria-label={t("editor.delete_node_tooltip")}
              className="wf-popover-delete-btn"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
        <NodeConfigCard
          readOnly={readOnly}
          selectedNode={selectedNode}
          sd={sd}
          nodeType={nodeType}
          handleIdChange={handleIdChange}
          setNodes={setNodes}
          setSelectedNode={setSelectedNode}
          updateNodeData={updateNodeData}
          agentList={agentList}
          meta={meta}
          updateMeta={updateMeta}
          customTools={customTools}
          nodes={nodes || []}
          workflowId={workflowId}
        />
      </PopoverContent>
    </Popover>
  );
}
