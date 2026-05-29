import type { Node } from "@xyflow/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
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
  agentList: Array<{ name: string; description: string | null }>;
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
}: NodeConfigPopoverProps) {
  const { t } = useTranslation("workflows");
  const anchorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (selectedNode) {
      anchorRef.current = document.querySelector(`[data-node-id="${selectedNode.id}"]`) as HTMLElement | null;
    }
  }, [selectedNode]);

  if (!selectedNode) return null;

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent side="right" align="start" sideOffset={8} collisionPadding={16} className="wf-node-popover">
        <div className="wf-popover-header">
          <span className="wf-popover-title">{selectedNode.id}</span>
          <span className="wf-popover-type">{t(`nodes.${nodeType}`)}</span>
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
  );
}
