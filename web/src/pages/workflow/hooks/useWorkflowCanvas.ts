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
import { getPresetById } from "../presets";
import {
  createStartNode,
  defaultMeta,
  nextEdgeId,
  nextNodeId,
  resetEdgeCounter,
  resetNodeCounter,
  START_NODE_ID,
  type WfMeta,
} from "../yaml-utils";

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
  setDryRunResult: (
    result: {
      valid: boolean;
      issues: Array<{ type: string; message: string; field?: string }>;
    } | null,
  ) => void;
  setYamlText: (text: string) => void;
  setSelectedRunNodeId: (id: string | null) => void;
}

export interface UseWorkflowCanvasReturn {
  onSelectionChange: OnSelectionChangeFunc;
  onConnect: (connection: Connection) => void;
  // React Flow 的 OnConnectStartFunction 第二个参数提供 nodeId/handleType，
  // 用于在 connection start 时知道源节点（WF-022 拖拽自动建节点依赖此）
  onConnectStart: (
    event: MouseEvent | TouchEvent,
    params: { nodeId?: string | null; handleId?: string | null; handleType?: string | null },
  ) => void;
  onConnectEnd: (event: MouseEvent | TouchEvent) => void;
  handleNodesDelete: (nodes: Node[]) => void;
  addNode: (
    type: string,
    presetOrPosition?: string | { x: number; y: number },
    positionFallback?: { x: number; y: number },
    tool?: string,
  ) => void;
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

      // 防止重复连接：同一对 source/target 已存在 edge 时直接返回。
      // 同时避免 ID 冲突：旧实现用 `logic-${source}-${target}` 作 ID，二次连接会产生重复 ID。
      setEdges((eds) => {
        const exists = eds.some((e) => e.source === connection.source && e.target === connection.target);
        if (exists) return eds;

        return addEdge(
          {
            ...connection,
            type: "logic",
            data: { hasCondition: false },
            id: nextEdgeId(connection.source, connection.target),
          },
          eds,
        );
      });

      // 自动补全：检测目标为 transform 节点且有预设时，自动填入 inputs + depends_on
      if (connection.target) {
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id !== connection.target) return n;
            if (n.data?.type !== "transform") return n;

            const presetId = n.data?._preset as string | undefined;
            if (!presetId) return n;

            const preset = getPresetById(presetId);
            if (!preset) return n;

            // 收集所有连接到该节点的上游节点 ID（现有 edges + 新连接）
            const existingUpstreamIds = edges.filter((e) => e.target === n.id).map((e) => e.source);
            const allUpstreamIds = [...new Set([...existingUpstreamIds, connection.source])];

            if (allUpstreamIds.length < preset.minUpstream) return n;

            // 按预设类型分配 inputs 变量名
            const inputs: Record<string, string> = {};
            if (preset.id === "merge") {
              allUpstreamIds.slice(0, 2).forEach((uid, i) => {
                inputs[`src${i + 1}`] = `nodes.${uid}.output`;
              });
            } else {
              inputs.data = `nodes.${allUpstreamIds[0]}.output`;
            }

            // 合并已有的 depends_on 和新连接的上游节点
            const existingDepends: string[] = Array.isArray(n.data?.depends_on) ? (n.data.depends_on as string[]) : [];

            return {
              ...n,
              data: {
                ...n.data,
                inputs,
                depends_on: [...new Set([...existingDepends, ...allUpstreamIds])],
              },
            };
          }),
        );
      }
    },
    [setEdges, setNodes, didConnect, edges],
  );

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent, params: { nodeId?: string | null; handleType?: string | null }) => {
      // WF-022 修复：旧实现把 sourceId 清空，导致 onConnectEnd 永远拿不到 source，
      // 拖拽空白处自动建节点功能完全失效。
      // 现在从 React Flow 的 connection start params 提取 nodeId 写入 ref。
      // handleType === 'source' 表示从 source handle 拉出，是创建新节点的合法场景；
      // handleType === 'target' 是从 target handle 反向拉出，不应建节点。
      pendingConnectSource.current = params?.handleType === "source" ? (params.nodeId ?? null) : null;
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
          id: nextEdgeId(sourceId, newId),
          source: sourceId,
          target: newId,
          type: "logic",
          data: { hasCondition: false },
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
    (
      type: string,
      presetOrPosition?: string | { x: number; y: number },
      positionFallback?: { x: number; y: number },
      tool?: string,
    ) => {
      // 参数兼容处理：第二个参数可能是 preset 字符串或 position 对象
      let preset: string | undefined;
      let position: { x: number; y: number } | undefined;
      if (typeof presetOrPosition === "string") {
        preset = presetOrPosition;
        position = positionFallback;
      } else {
        position = presetOrPosition;
      }

      const presetConfig = preset ? getPresetById(preset) : undefined;
      const id = nextNodeId(type);
      const newNode: Node = {
        id,
        type,
        position: position ?? { x: 300 + Math.random() * 200, y: 100 + Math.random() * 200 },
        data: {
          ...(presetConfig
            ? {
                output: { ...presetConfig.defaultOutput },
                _preset: preset,
              }
            : {}),
          // custom 类型携带 tool 字段
          ...(type === "custom" && tool ? { tool } : {}),
        },
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
      const preset = event.dataTransfer.getData("application/workflow-preset");
      const tool = event.dataTransfer.getData("application/workflow-tool") || undefined;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      if (type === "custom" && tool) {
        addNode("custom", position, undefined, tool);
      } else {
        addNode(type, preset || position, preset ? position : undefined);
      }
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
    resetEdgeCounter();
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
      const newEdges = edges.map((e) => {
        if (e.source !== oldId && e.target !== oldId) return e;
        const newSource = e.source === oldId ? newId : e.source;
        const newTarget = e.target === oldId ? newId : e.target;
        return {
          ...e,
          source: newSource,
          target: newTarget,
          // 重写 ID 时同样用 nextEdgeId 防止冲突
          id: nextEdgeId(newSource, newTarget),
        };
      });
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
