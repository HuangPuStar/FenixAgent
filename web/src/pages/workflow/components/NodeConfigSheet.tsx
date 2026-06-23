import type { Node } from "@xyflow/react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { CustomToolItem } from "../../../api/workflow-defs";
import type { AgentNodeOption } from "../hooks/useWorkflowMetaAgent";
import type { WfMeta } from "../yaml-utils";
import { START_NODE_ID } from "../yaml-utils";
import { NodeConfigCard } from "./NodeConfigCard";

export interface NodeConfigSheetProps {
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
  onDeleteRequest: (nodeId: string) => void;
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
  customTools: CustomToolItem[];
}

export function NodeConfigSheet({
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
}: NodeConfigSheetProps) {
  const { t } = useTranslation("workflows");

  if (!selectedNode) return null;

  const isStartNode = selectedNode.id === START_NODE_ID;
  const canDelete = !readOnly && !isStartNode;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        style={{ width: 420, maxWidth: 420, padding: 0 }}
        className="wf-node-sheet"
      >
        <SheetHeader className="wf-popover-header" style={{ paddingLeft: 16, paddingRight: 16 }}>
          <SheetTitle className="wf-popover-title">
            {isStartNode ? t("editor.workflow_settings") : selectedNode.id}
          </SheetTitle>
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
        </SheetHeader>
        <div className="wf-sheet-body">
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
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
