import type { Edge, Node } from "@xyflow/react";
import { useCallback } from "react";

/**
 * 画布上的**节点交互**：点选节点（开合配置面板）、拖动开始时收起面板、删除节点。
 *
 * 三者的共同点是「同时改画布数据与配置面板的开关」——点节点要开面板、移画布要关面板、删节点要连边一起清。
 * 从编辑器抽出后，面板开关与节点的联动只有这一处定义；运行态下的差异（run mode 只切选中节点、
 * 不弹面板）也在同一处表达。
 *
 * 状态仍由编辑器持有（与运行视图态同一口径），本 hook 只接收当前值与 setter。
 */
export interface UseWorkflowNodeInteractionsParams {
  /** run mode 下点击节点只切换选中，不弹配置面板 */
  isRunMode: boolean;
  selectedNode: Node | null;
  nodeConfigSheetOpen: boolean;
  setSelectedNode: React.Dispatch<React.SetStateAction<Node | null>>;
  setNodeConfigSheetOpen: (open: boolean) => void;
  setSelectedRunNodeId: (id: string | null) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
}

export interface UseWorkflowNodeInteractionsReturn {
  handleNodeClick: (event: React.MouseEvent, node: Node) => void;
  handleMoveStart: () => void;
  handleDeleteNode: (nodeId: string) => void;
}

export function useWorkflowNodeInteractions({
  isRunMode,
  selectedNode,
  nodeConfigSheetOpen,
  setSelectedNode,
  setNodeConfigSheetOpen,
  setSelectedRunNodeId,
  setNodes,
  setEdges,
}: UseWorkflowNodeInteractionsParams): UseWorkflowNodeInteractionsReturn {
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (isRunMode) {
        // run mode 下运行情况显示在固定右侧栏（wf-run-panel），点击节点只需切换
        // selectedRunNodeId，useWorkflowRun 会自动拉 getOutput 并切到 output 子 tab。
        setSelectedRunNodeId(node.id);
        setSelectedNode(node);
        return;
      }
      if (selectedNode?.id === node.id && nodeConfigSheetOpen) {
        setNodeConfigSheetOpen(false);
        setSelectedNode(null);
      } else {
        setSelectedNode(node);
        setNodeConfigSheetOpen(true);
      }
    },
    [nodeConfigSheetOpen, selectedNode, isRunMode, setSelectedRunNodeId, setSelectedNode, setNodeConfigSheetOpen],
  );

  /** 画布移动时关闭 popover */
  const handleMoveStart = useCallback(() => {
    if (nodeConfigSheetOpen) {
      setNodeConfigSheetOpen(false);
      setSelectedNode(null);
    }
  }, [nodeConfigSheetOpen, setNodeConfigSheetOpen, setSelectedNode]);

  /**
   * 从 Sheet 删除当前选中节点。
   * 与 ReactFlow 内置 deleteKeyCode 不同，这里是手动触发，需要同时清理 nodes、edges、Sheet 状态。
   * 开始节点（START_NODE_ID）和只读模式下由 NodeConfigSheet 自身屏蔽，不进入此回调。
   */
  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setNodeConfigSheetOpen(false);
      setSelectedNode(null);
    },
    [setNodes, setEdges, setNodeConfigSheetOpen, setSelectedNode],
  );

  return { handleNodeClick, handleMoveStart, handleDeleteNode };
}
