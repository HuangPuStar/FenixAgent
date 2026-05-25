import {
  addEdge,
  type Connection,
  type Edge,
  type Node,
  type OnSelectionChangeFunc,
  type XYPosition,
} from "@xyflow/react";
import { type RefObject, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { autoLayout } from "../layout";
import { createStartNode, defaultMeta, nextNodeId, resetNodeCounter, START_NODE_ID, type WfMeta } from "../yaml-utils";

export interface UseWorkflowCanvasParams {
  nodes: Node[];
  edges: Edge[];
  setNodes: ReturnType<typeof import("@xyflow/react").useNodesState<Node>>[1];
  setEdges: ReturnType<typeof import("@xyflow/react").useEdgesState<Edge>>[1];
  setMeta: (fn: (prev: WfMeta) => WfMeta) => void;
  setSelectedNode: (node: Node | null) => void;
  readOnly: boolean;
  activeRunId: string | null;
  selectedNode: Node | null;
  screenToFlowPosition: (pos: { x: number; y: number }) => XYPosition;
  fitView: (opts?: { padding?: number; duration?: number }) => void;
  pendingConnectSource: RefObject<string | null>;
  didConnect: RefObject<boolean>;
  setDryRunResult: (result: {
    valid: boolean;
    issues: Array<{ type: string; message: string; field?: string }>;
  } | null) => void;
  setYamlText: (text: string) => void;
  setSelectedRunNodeId: (id: string | null) => void;
}

export interface UseWorkflowCanvasReturn {
  onSelectionChange: OnSelectionChangeFunc;
  onConnect: (connection: Connection) => void;
  onConnectStart: (event: MouseEvent | TouchEvent) => void;
  onConnectEnd: (event: MouseEvent | TouchEvent) => void;
  handleNodesDelete: (nodes: Node[]) => void;
  addNode: (type: string, position?: { x: number; y: number }) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  handleAutoLayout: () => void;
  handleNew: () => void;
  updateNodeData: (data: Record<string, unknown>) => void;
  handleIdChange: (newId: string) => void;
}

export function useWorkflowCanvas(params: UseWorkflowCanvasParams): UseWorkflowCanvasReturn {
  const {
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
    setDryRunResult,
    setYamlText,
    setSelectedRunNodeId,
  } = params;

  const { t } = useTranslation("workflows");

  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selNodes }) => {
      setSelectedNode(selNodes[0] ?? null);
      if (activeRunId && selNodes[0] && selNodes[0].id !== START_NODE_ID) {
        setSelectedRunNodeId(selNodes[0].id);
      }
    },
    [activeRunId, setSelectedNode, setSelectedRunNodeId],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      didConnect.current = true;
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: "smoothstep",
            animated: connection.source !== START_NODE_ID,
            id: `e-${connection.source}-${connection.target}`,
          },
          eds,
        ),
      );
    },
    [setEdges, didConnect],
  );

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent) => {
      pendingConnectSource.current = null;
      didConnect.current = false;
    },
    [pendingConnectSource, didConnect],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const sourceId = pendingConnectSource.current;
      pendingConnectSource.current = null;

      if (!sourceId || readOnly || didConnect.current) return;
      didConnect.current = false;

      const sourceNode = nodes.find((n) => n.id === sourceId);
      if (!sourceNode) return;

      const newType = sourceId === START_NODE_ID ? "shell" : (sourceNode.type ?? "shell");
      const newId = nextNodeId(newType);
      const position = screenToFlowPosition({
        x: (event as MouseEvent).clientX,
        y: (event as MouseEvent).clientY,
      });

      const newNode: Node = { id: newId, type: newType, position, data: {} };
      setNodes((nds) => [...nds, newNode]);
      setEdges((eds) => [
        ...eds,
        {
          id: `e-${sourceId}-${newId}`,
          source: sourceId,
          target: newId,
          type: "smoothstep",
          animated: sourceId !== START_NODE_ID,
        },
      ]);
    },
    [nodes, readOnly, screenToFlowPosition, setNodes, setEdges, pendingConnectSource, didConnect],
  );

  const handleNodesDelete = useCallback(
    (deleted: Node[]) => {
      const filtered = deleted.filter((n) => n.id !== START_NODE_ID);
      if (filtered.length === 0) return;
      setNodes((nds) => nds.filter((n) => !filtered.some((d) => d.id === n.id)));
    },
    [setNodes],
  );

  const addNode = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      const id = nextNodeId(type);
      const newNode: Node = {
        id,
        type,
        position: position ?? { x: 300 + Math.random() * 200, y: 100 + Math.random() * 200 },
        data: {},
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [setNodes],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/workflow-node");
      if (!type) return;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode(type, position);
    },
    [screenToFlowPosition, addNode],
  );

  const handleAutoLayout = useCallback(() => {
    const laid = autoLayout(nodes, edges);
    setNodes(laid);
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
  }, [nodes, edges, setNodes, fitView]);

  const handleNew = useCallback(() => {
    setNodes([createStartNode()]);
    setEdges([]);
    setSelectedNode(null);
    setMeta(() => ({ ...defaultMeta }));
    setYamlText("");
    setDryRunResult(null);
    resetNodeCounter();
  }, [setNodes, setEdges, setSelectedNode, setMeta, setYamlText, setDryRunResult]);

  const updateNodeData = useCallback(
    (updates: Record<string, unknown>) => {
      if (!selectedNode) return;
      setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, ...updates } } : n)));
      setSelectedNode(selectedNode ? { ...selectedNode, data: { ...selectedNode.data, ...updates } } : null);
    },
    [selectedNode, setNodes, setSelectedNode],
  );

  const handleIdChange = useCallback(
    (newId: string) => {
      if (!selectedNode || newId === selectedNode.id || !newId.trim()) return;
      if (newId === START_NODE_ID) return;
      if (nodes.some((n) => n.id === newId)) {
        toast.error(t("editor.node_id_exists"));
        return;
      }
      const oldId = selectedNode.id;
      const newNode: Node = { ...selectedNode, id: newId };
      const newEdges = edges.map((e) => ({
        ...e,
        source: e.source === oldId ? newId : e.source,
        target: e.target === oldId ? newId : e.target,
        id:
          e.source === oldId || e.target === oldId
            ? `e-${e.source === oldId ? newId : e.source}-${e.target === oldId ? newId : e.target}`
            : e.id,
      }));
      setNodes((nds) => [...nds.filter((n) => n.id !== oldId), newNode]);
      setEdges(newEdges);
      setSelectedNode(newNode);
    },
    [selectedNode, nodes, edges, setNodes, setEdges, setSelectedNode, t],
  );

  return {
    onSelectionChange,
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
  };
}
