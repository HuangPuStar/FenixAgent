import type { Node } from "@xyflow/react";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type Measurable = { getBoundingClientRect(): DOMRect };

import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { AgentNodeOption } from "../hooks/useWorkflowMetaAgent";
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
  /** 删除当前选中节点；父组件负责同步清理 edges、关闭 popover */
  onDeleteNode: (nodeId: string) => void;
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
  onDeleteNode,
}: NodeConfigPopoverProps) {
  const { t } = useTranslation("workflows");
  const anchorRef = useRef<Measurable>(null!);
  // 删除确认弹窗状态独立于 popover，避免 popover 关闭时丢失确认上下文
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  useEffect(() => {
    if (selectedNode) {
      anchorRef.current = document.querySelector(`[data-node-id="${selectedNode.id}"]`)!;
    }
  }, [selectedNode]);

  if (!selectedNode) return null;

  // 开始节点是工作流入口，禁止删除；readOnly / preview 模式下也禁用
  const isStartNode = selectedNode.id === START_NODE_ID;
  const canDelete = !readOnly && !isStartNode;

  const handleDeleteClick = () => {
    if (!selectedNode || !canDelete) return;
    setConfirmDeleteOpen(true);
  };

  const handleConfirmDelete = () => {
    if (!selectedNode) return;
    const nodeId = selectedNode.id;
    setConfirmDeleteOpen(false);
    onDeleteNode(nodeId);
  };

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange} modal={false}>
        <PopoverAnchor virtualRef={anchorRef} />
        <PopoverContent side="right" align="start" sideOffset={8} collisionPadding={16} className="wf-node-popover">
          <div className="wf-popover-header">
            <span className="wf-popover-title">{selectedNode.id}</span>
            <span className="wf-popover-type">{t(`nodes.${nodeType}`)}</span>
            {canDelete && (
              <button
                type="button"
                onClick={handleDeleteClick}
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
          />
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={t("editor.delete_node_tooltip")}
        description={t("editor.delete_node_confirm", { nodeId: selectedNode.id })}
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}
