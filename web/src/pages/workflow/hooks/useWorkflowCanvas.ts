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
  /** 拖拽连接开始时的 handleId，用于判断用户是从数据 handle（out-xxx）还是逻辑 handle 拖出 */
  pendingConnectHandleId: RefObject<string | null>;
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
    outputs?: Record<string, { pattern: string; type: string }>,
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
    pendingConnectHandleId,
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

      // 自动补全 inputs：从前面的 output 连入后面时，自动填写关系
      // - out-xxx → in-xxx：精确填充对应输入
      // - out-xxx → 逻辑 handle：智能匹配目标节点的输入（单输入或同名输入）
      // - 逻辑 handle → 任意：不填（无输出点 → 空传递）
      if (connection.target) {
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id !== connection.target) return n;

            // 源端是否为数据 handle（out-xxx）
            const isDataSource =
              typeof connection.sourceHandle === "string" && connection.sourceHandle.startsWith("out-");
            // 目标端是否为数据 handle（in-xxx）
            const isDataTarget =
              typeof connection.targetHandle === "string" && connection.targetHandle.startsWith("in-");
            // 精确数据连接：out-xxx → in-xxx
            const isDataConnect = isDataSource && isDataTarget;
            const fieldName = isDataSource ? connection.sourceHandle!.slice(4) : undefined;

            // 辅助函数：尝试智能匹配目标节点的输入
            // 策略：1) 唯一输入直接填  2) 同名输入匹配  3) 否则不填（空传递）
            const trySmartFill = (node: typeof n, outField: string): typeof n | null => {
              const inputs = (node.data?.inputs as Record<string, string> | undefined) ?? {};
              const inputKeys = Object.keys(inputs);
              if (inputKeys.length === 0) return null; // 无输入点 → 空传递
              const valueExpr = `nodes.${connection.source}.output.${outField}`;
              if (inputKeys.length === 1) {
                // 只有一个输入，自动填充
                return { ...node, data: { ...node.data, inputs: { ...inputs, [inputKeys[0]]: valueExpr } } };
              }
              if (inputKeys.includes(outField)) {
                // 有同名输入，自动匹配
                return { ...node, data: { ...node.data, inputs: { ...inputs, [outField]: valueExpr } } };
              }
              // 多个输入且无匹配 → 空传递，不填
              return null;
            };

            // ── transform 节点预设自动填充（保持原有逻辑）──
            if (n.data?.type === "transform") {
              const presetId = n.data?._preset as string | undefined;
              if (!presetId) {
                // 无 preset 时按通用数据连接处理
                if (isDataConnect && fieldName) {
                  const paramName = connection.targetHandle!.slice(3); // 去掉 "in-" 前缀
                  const valueExpr = `nodes.${connection.source}.output.${fieldName}`;
                  const existingInputs = (n.data?.inputs as Record<string, string> | undefined) ?? {};
                  return {
                    ...n,
                    data: { ...n.data, inputs: { ...existingInputs, [paramName]: valueExpr } },
                  };
                }
                // out-xxx → 逻辑 handle，尝试智能匹配
                if (isDataSource && !isDataTarget && fieldName) {
                  const filled = trySmartFill(n, fieldName);
                  if (filled) return filled;
                }
                return n;
              }

              const preset = getPresetById(presetId);
              if (!preset) {
                // 预设不存在时也按通用数据连接处理
                if (isDataConnect && fieldName) {
                  const paramName = connection.targetHandle!.slice(3);
                  const valueExpr = `nodes.${connection.source}.output.${fieldName}`;
                  const existingInputs = (n.data?.inputs as Record<string, string> | undefined) ?? {};
                  return {
                    ...n,
                    data: { ...n.data, inputs: { ...existingInputs, [paramName]: valueExpr } },
                  };
                }
                // out-xxx → 逻辑 handle，尝试智能匹配
                if (isDataSource && !isDataTarget && fieldName) {
                  const filled = trySmartFill(n, fieldName);
                  if (filled) return filled;
                }
                return n;
              }

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
              const existingDepends: string[] = Array.isArray(n.data?.depends_on)
                ? (n.data.depends_on as string[])
                : [];

              return {
                ...n,
                data: {
                  ...n.data,
                  inputs,
                  depends_on: [...new Set([...existingDepends, ...allUpstreamIds])],
                },
              };
            }

            // ── 通用节点：out-xxx → in-xxx，精确填充对应输入 ──
            if (isDataConnect && fieldName) {
              const paramName = connection.targetHandle!.slice(3); // 去掉 "in-" 前缀
              const valueExpr = `nodes.${connection.source}.output.${fieldName}`;
              const existingInputs = (n.data?.inputs as Record<string, string> | undefined) ?? {};
              return {
                ...n,
                data: { ...n.data, inputs: { ...existingInputs, [paramName]: valueExpr } },
              };
            }

            // ── out-xxx → 逻辑 handle，智能匹配输入 ──
            if (isDataSource && !isDataTarget && fieldName) {
              const filled = trySmartFill(n, fieldName);
              if (filled) return filled;
            }

            return n;
          }),
        );
      }
    },
    [setEdges, setNodes, didConnect, edges],
  );

  const onConnectStart = useCallback(
    (
      _event: MouseEvent | TouchEvent,
      params: { nodeId?: string | null; handleId?: string | null; handleType?: string | null },
    ) => {
      // WF-022 修复：旧实现把 sourceId 清空，导致 onConnectEnd 永远拿不到 source，
      // 拖拽空白处自动建节点功能完全失效。
      // 现在从 React Flow 的 connection start params 提取 nodeId 写入 ref。
      // handleType === 'source' 表示从 source handle 拉出，是创建新节点的合法场景；
      // handleType === 'target' 是从 target handle 反向拉出，不应建节点。
      pendingConnectSource.current = params?.handleType === "source" ? (params.nodeId ?? null) : null;
      // 记录 handleId，用于 onConnectEnd 判断是从数据 handle（out-xxx）还是逻辑 handle 拖出
      pendingConnectHandleId.current = params?.handleType === "source" ? (params.handleId ?? null) : null;
      didConnect.current = false;
    },
    [pendingConnectSource, pendingConnectHandleId, didConnect],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const sourceId = pendingConnectSource.current;
      const handleId = pendingConnectHandleId.current;
      pendingConnectSource.current = null;
      pendingConnectHandleId.current = null;

      if (!sourceId || readOnly || didConnect.current) return;
      didConnect.current = false;

      const sourceNode = nodes.find((n) => n.id === sourceId);
      if (!sourceNode) return;

      // custom 节点（如 llm）的输出是计算值，拖拽不自动创建下游节点
      if (sourceNode.type === "custom") return;

      const newType = sourceId === START_NODE_ID ? "shell" : (sourceNode.type ?? "shell");
      const newId = nextNodeId(newType);
      const position = screenToFlowPosition({
        x: (event as MouseEvent).clientX,
        y: (event as MouseEvent).clientY,
      });

      // 从数据 output handle（out-xxx）拖出时，自动为新节点填入 inputs，建立数据流关联
      const data: Record<string, unknown> = {
        // 默认输出与 addNode 保持一致
        ...(newType !== "custom" ? { outputs: { stdout: { pattern: "", type: "value" } } } : {}),
      };
      if (handleId?.startsWith("out-")) {
        const fieldName = handleId.slice(4); // 去掉 "out-" 前缀
        data.inputs = { data: `nodes.${sourceId}.output.${fieldName}` };
      }

      const newNode: Node = { id: newId, type: newType, position, data };
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
    [
      nodes,
      readOnly,
      screenToFlowPosition,
      setNodes,
      setEdges,
      pendingConnectSource,
      pendingConnectHandleId,
      didConnect,
    ],
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
      outputs?: Record<string, { pattern: string; type: string }>,
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
          // 所有普通节点默认输出 stdout，自定义节点由 palette 传 outputs 或走工具 produces
          ...(type !== "custom" ? { outputs: { stdout: { pattern: "", type: "value" } } } : {}),
          ...(presetConfig
            ? {
                output: { ...presetConfig.defaultOutput },
                _preset: preset,
              }
            : {}),
          // custom 类型携带 tool 字段 + 默认 outputs
          ...(type === "custom" && tool ? { tool, ...(outputs ? { outputs } : {}) } : {}),
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
        const outputsJson = event.dataTransfer.getData("application/workflow-outputs") || undefined;
        const outputs = outputsJson
          ? (JSON.parse(outputsJson) as Record<string, { pattern: string; type: string }>)
          : undefined;
        addNode("custom", position, undefined, tool, outputs);
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
