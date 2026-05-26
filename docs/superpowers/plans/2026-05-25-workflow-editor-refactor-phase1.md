# WorkflowEditor 重构 Phase 1：Hook 拆分 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 WorkflowEditor.tsx 的逻辑拆分为 4 个自定义 hook，每个负责独立职责。状态留在顶层通过参数传递。

**Architecture:** 4 个 hook（useWorkflowMetaAgent、useWorkflowCanvas、useWorkflowPersistence、useWorkflowRun）接收 WorkflowEditor 的状态作为参数，返回回调和内部持有的状态。Hook 之间不直接依赖，WorkflowEditor 负责连接。

**Tech Stack:** React 19 hooks, TypeScript, @xyflow/react, react-i18next, sonner

---

## 文件结构

| 文件 | 操作 | 说明 |
|------|------|------|
| `web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts` | 新建 | Meta Agent 集成 hook |
| `web/src/pages/workflow/hooks/useWorkflowCanvas.ts` | 新建 | 画布交互 hook |
| `web/src/pages/workflow/hooks/useWorkflowPersistence.ts` | 新建 | 保存/发布 hook |
| `web/src/pages/workflow/hooks/useWorkflowRun.ts` | 新建 | 运行模式 hook |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 修改 | 替换内联逻辑为 hook 调用 |

---

### Task 1: 创建 hooks 目录 + 提取 useWorkflowMetaAgent

**Files:**
- Create: `web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx` (lines 126-178 → hook 调用)

**说明:** useWorkflowMetaAgent 是最简单、无外部 hook 依赖的 hook。包含 chat 状态持久化、metaAgentId 管理、agent 列表加载。

- [ ] **Step 1: 创建 `web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts`**

从 WorkflowEditor.tsx 提取以下逻辑：
- 状态：`chatOpen`（行 127-130）、`metaAgentId`（行 131）
- `scenePrompt` useMemo（行 135-146）
- chat 持久化 useEffect（行 148-155）
- agent 列表状态 `agentList`、`agentOverrideOpen`（行 158-161）
- agent 列表加载 useEffect（行 163-178）

```typescript
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { agentApi } from "@/src/api/sdk";
import { ensureMetaAgent } from "../../../api/meta-agent";
import type { WfMeta } from "../yaml-utils";

export interface UseWorkflowMetaAgentParams {
  workflowId: string | undefined;
  meta: WfMeta;
}

export interface UseWorkflowMetaAgentReturn {
  scenePrompt: string | undefined;
  chatOpen: boolean;
  setChatOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  metaAgentId: string | null;
  agentList: Array<{ name: string; model: string | null; description: string | null }>;
  agentOverrideOpen: boolean;
  setAgentOverrideOpen: (open: boolean) => void;
}

export function useWorkflowMetaAgent({ workflowId, meta }: UseWorkflowMetaAgentParams): UseWorkflowMetaAgentReturn {
  const { t } = useTranslation("workflows");

  const [chatOpen, setChatOpen] = useState(() => {
    const saved = localStorage.getItem("wf-editor:chat-open");
    return saved === "true";
  });
  const [metaAgentId, setMetaAgentId] = useState<string | null>(null);

  const scenePrompt = useMemo(() => {
    if (!workflowId) return;
    const lines = [
      t("editor.workflow_context"),
      `- ${t("editor.workflow_id")}: ${workflowId}`,
      `- ${t("editor.workflow_name")}: ${meta.name || t("editor.workflow_unnamed")}`,
      `- ${t("editor.workflow_desc_label")}: ${meta.description || t("editor.workflow_no_desc")}`,
      `- ${t("editor.workflow_draft_path")}: .agents/workflows/${workflowId}/draft.yaml`,
      t("editor.workflow_read_prompt"),
    ];
    return lines.join("\n");
  }, [workflowId, meta.name, meta.description, t]);

  useEffect(() => {
    localStorage.setItem("wf-editor:chat-open", String(chatOpen));
    if (chatOpen && !metaAgentId) {
      ensureMetaAgent()
        .then((res) => setMetaAgentId(res.environmentId))
        .catch((err) => console.error("Meta Agent failed:", err));
    }
  }, [chatOpen, metaAgentId]);

  const [agentList, setAgentList] = useState<Array<{ name: string; model: string | null; description: string | null }>>(
    [],
  );
  const [agentOverrideOpen, setAgentOverrideOpen] = useState(false);

  useEffect(() => {
    agentApi
      .list()
      .then(({ data }) => {
        if (Array.isArray(data)) {
          setAgentList(
            data.map((a) => ({
              name: a.name,
              model: a.model ?? null,
              description: a.description ?? null,
            })),
          );
        }
      })
      .catch((err: unknown) => console.error("Failed to load agent list:", err));
  }, []);

  return {
    scenePrompt,
    chatOpen,
    setChatOpen,
    metaAgentId,
    agentList,
    agentOverrideOpen,
    setAgentOverrideOpen,
  };
}
```

- [ ] **Step 2: 修改 WorkflowEditor.tsx，替换内联 Meta Agent 逻辑为 hook 调用**

在 `WorkflowEditorInner` 函数内：
1. 添加 import：`import { useWorkflowMetaAgent } from "./hooks/useWorkflowMetaAgent";`
2. 删除行 126-178（chatOpen, metaAgentId, scenePrompt, agentList, agentOverrideOpen 的声明和 useEffect）
3. 在删除位置插入 hook 调用：

```typescript
  // ── Meta Agent Chat ──
  const {
    scenePrompt,
    chatOpen,
    setChatOpen,
    metaAgentId,
    agentList,
    agentOverrideOpen,
    setAgentOverrideOpen,
  } = useWorkflowMetaAgent({ workflowId, meta });
```

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 提取 useWorkflowMetaAgent hook"
```

---

### Task 2: 提取 useWorkflowCanvas

**Files:**
- Create: `web/src/pages/workflow/hooks/useWorkflowCanvas.ts`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx` (lines 253-379, 827-863 → hook 调用)

**说明:** 画布交互 hook，包含选择、连接、拖拽创建、删除、添加节点、自动布局、新建、更新节点数据、ID 变更。

- [ ] **Step 1: 创建 `web/src/pages/workflow/hooks/useWorkflowCanvas.ts`**

从 WorkflowEditor.tsx 提取以下逻辑：
- `onSelectionChange`（行 253-262）
- `onConnect`（行 264-281）
- `onConnectStart`/`onConnectEnd`（行 283-321）
- `handleNodesDelete`（行 323-331）
- `addNode`（行 340-353）
- `onDragOver`/`onDrop`（行 355-373）
- `handleAutoLayout`（行 375-380）
- `handleNew`（行 382-391）
- `updateNodeData`（行 828-836）
- `handleIdChange`（行 838-863）

需要的额外状态（从 WorkflowEditor 传入的 ref）：
- `pendingConnectSource` ref
- `didConnect` ref

```typescript
import { type Connection, type Edge, type Node, type OnSelectionChangeFunc, type XYPosition, addEdge } from "@xyflow/react";
import { useCallback, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { autoLayout } from "../layout";
import { createStartNode, nextNodeId, resetNodeCounter, START_NODE_ID, type WfMeta } from "../yaml-utils";

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
  screenToFlowPosition: ReturnType<typeof import("@xyflow/react").useReactFlow>["screenToFlowPosition"];
  fitView: ReturnType<typeof import("@xyflow/react").useReactFlow>["fitView"];
  pendingConnectSource: RefObject<string | null>;
  didConnect: RefObject<boolean>;
  setDryRunResult: (result: { valid: boolean; issues: Array<{ type: string; message: string; field?: string }> } | null) => void;
  setYamlText: (text: string) => void;
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
  } = params;

  const { t } = useTranslation("workflows");

  // ── Selection ──
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selNodes }) => {
      setSelectedNode(selNodes[0] ?? null);
    },
    [setSelectedNode],
  );

  // ── Connection ──
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

  // ── Drag-to-create ──
  const onConnectStart = useCallback((_event: MouseEvent | TouchEvent) => {
    pendingConnectSource.current = null;
    didConnect.current = false;
  }, [pendingConnectSource, didConnect]);

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

  // ── Prevent deleting start node ──
  const handleNodesDelete = useCallback(
    (deleted: Node[]) => {
      const filtered = deleted.filter((n) => n.id !== START_NODE_ID);
      if (filtered.length === 0) return;
      setNodes((nds) => nds.filter((n) => !filtered.some((d) => d.id === n.id)));
    },
    [setNodes],
  );

  // ── Add node at position ──
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

  // ── DnD: drag from palette ──
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

  // ── Auto layout ──
  const handleAutoLayout = useCallback(() => {
    const laid = autoLayout(nodes, edges);
    setNodes(laid);
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
  }, [nodes, edges, setNodes, fitView]);

  // ── New workflow ──
  const handleNew = useCallback(() => {
    setNodes([createStartNode()]);
    setEdges([]);
    setSelectedNode(null);
    setMeta(() => ({ ...import("../yaml-utils").defaultMeta }));
    setYamlText("");
    setDryRunResult(null);
    resetNodeCounter();
  }, [setNodes, setEdges, setSelectedNode, setMeta, setYamlText, setDryRunResult]);

  // ── Update selected node data ──
  const updateNodeData = useCallback(
    (updates: Record<string, unknown>) => {
      if (!selectedNode) return;
      setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, ...updates } } : n)));
      setSelectedNode(selectedNode ? { ...selectedNode, data: { ...selectedNode.data, ...updates } } : null);
    },
    [selectedNode, setNodes, setSelectedNode],
  );

  // ── Change node ID ──
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
```

注意：`handleNew` 中 `setMeta(() => ({ ...defaultMeta }))` 改为 `setMeta(() => ({ ...import("../yaml-utils").defaultMeta }))` 不好，应该在顶部 import defaultMeta。修正：

```typescript
import { createStartNode, defaultMeta, nextNodeId, resetNodeCounter, START_NODE_ID, type WfMeta } from "../yaml-utils";
```

然后 `handleNew` 中：
```typescript
setMeta(() => ({ ...defaultMeta }));
```

同理 `onSelectionChange` 不需要 `activeRunId` 参数了（原代码中有 `setSelectedRunNodeId` 的逻辑，但这个属于 Run 状态，应该在 WorkflowEditorInner 层面处理或通过回调）。原始代码行 257-259：

```typescript
if (activeRunId && selNodes[0] && selNodes[0].id !== START_NODE_ID) {
  setSelectedRunNodeId(selNodes[0].id);
}
```

这部分逻辑属于运行模式，不应该在 Canvas hook 里。方案：onSelectionChange 不处理 runNode 选择，由 WorkflowEditorInner 在调用 hook 后额外包装。

- [ ] **Step 2: 修改 WorkflowEditor.tsx，替换内联画布逻辑为 hook 调用**

1. 添加 import：`import { useWorkflowCanvas } from "./hooks/useWorkflowCanvas";`
2. 删除行 253-379、827-863（所有画布回调）
3. 在 hook 调用区域插入：

```typescript
  // ── Canvas refs (保留在 WorkflowEditorInner) ──
  const pendingConnectSource = useRef<string | null>(null);
  const didConnect = useRef(false);

  // ── Canvas hook ──
  const {
    onSelectionChange: canvasSelectionChange,
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
  } = useWorkflowCanvas({
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
  });

  // 运行模式下选中节点也更新 selectedRunNodeId
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selNodes }) => {
      canvasSelectionChange({ nodes: selNodes });
      if (activeRunId && selNodes[0] && selNodes[0].id !== START_NODE_ID) {
        setSelectedRunNodeId(selNodes[0].id);
      }
    },
    [canvasSelectionChange, activeRunId],
  );
```

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/hooks/useWorkflowCanvas.ts web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 提取 useWorkflowCanvas hook"
```

---

### Task 3: 提取 useWorkflowPersistence

**Files:**
- Create: `web/src/pages/workflow/hooks/useWorkflowPersistence.ts`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx` (lines 333-513 → hook 调用)

**说明:** 保存/发布/YAML 同步 hook。包含 syncYaml、import/export、file import、save draft、publish、Cmd+S 快捷键。此 hook 内部持有 saveStatus、publishing、lastSavedYaml 状态。

- [ ] **Step 1: 创建 `web/src/pages/workflow/hooks/useWorkflowPersistence.ts`**

从 WorkflowEditor.tsx 提取以下逻辑：
- `syncYaml`（行 333-338）
- `handleImportYaml`（行 393-414）
- `handleExportYaml`（行 416-426）
- `handleFileImport`（行 428-454）
- `handleSaveDraft`（行 456-472）
- `handlePublish`（行 474-501）
- Cmd+S useEffect（行 503-513）
- 内部状态：`lastSavedYaml`（行 193）、`saveStatus`（行 194）、`publishing`（行 195）

```typescript
import { type Edge, type Node } from "@xyflow/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { workflowDefApi } from "../../../api/workflow-defs";
import { pushWorkflowError } from "../../../lib/use-workflow-events";
import { autoLayout } from "../layout";
import { flowToYaml, type WfMeta, yamlToFlow } from "../yaml-utils";

export interface UseWorkflowPersistenceParams {
  workflowId: string | undefined;
  meta: WfMeta;
  nodes: Node[];
  edges: Edge[];
  setNodes: ReturnType<typeof import("@xyflow/react").useNodesState<Node>>[1];
  setEdges: ReturnType<typeof import("@xyflow/react").useEdgesState<Edge>>[1];
  fitView: ReturnType<typeof import("@xyflow/react").useReactFlow>["fitView"];
  yamlOpen: boolean;
  yamlText: string;
  setYamlText: (text: string) => void;
  setSelectedNode: (node: Node | null) => void;
  setMeta: (fn: (prev: WfMeta) => WfMeta) => void;
  setDryRunResult: (result: { valid: boolean; issues: Array<{ type: string; message: string; field?: string }> } | null) => void;
  activeRunId: string | null;
}

export interface UseWorkflowPersistenceReturn {
  syncYaml: () => string;
  handleImportYaml: () => void;
  handleExportYaml: () => void;
  handleFileImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSaveDraft: () => Promise<void>;
  handlePublish: () => Promise<void>;
  saveStatus: "idle" | "saving" | "saved";
  publishing: boolean;
}

export function useWorkflowPersistence(params: UseWorkflowPersistenceParams): UseWorkflowPersistenceReturn {
  const {
    workflowId,
    meta,
    nodes,
    edges,
    setNodes,
    setEdges,
    fitView,
    yamlOpen,
    yamlText,
    setYamlText,
    setSelectedNode,
    setMeta,
    setDryRunResult,
  } = params;

  const { t } = useTranslation("workflows");

  const [_lastSavedYaml, setLastSavedYaml] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [publishing, setPublishing] = useState(false);

  // ── Sync YAML ──
  const syncYaml = useCallback(() => {
    const y = flowToYaml(nodes, edges, meta);
    setYamlText(y);
    return y;
  }, [nodes, edges, meta, setYamlText]);

  // ── Import YAML ──
  const handleImportYaml = useCallback(() => {
    if (yamlOpen) {
      const text = yamlText.trim();
      if (!text) return;
      try {
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(text);
        setNodes(newNodes);
        setEdges(newEdges);
        setMeta(() => newMeta);
        setSelectedNode(null);
        setDryRunResult(null);
        setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
      } catch (err) {
        console.error(err);
        toast.error(`${t("editor.import_yaml_failed")}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      syncYaml();
      // 需要调用者设置 yamlOpen=true，通过返回值通知
    }
  }, [yamlOpen, yamlText, setNodes, setEdges, setMeta, setSelectedNode, setDryRunResult, syncYaml, fitView, t]);

  // ── Export YAML ──
  const handleExportYaml = useCallback(() => {
    const y = syncYaml();
    const blob = new Blob([y], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meta.name || "workflow"}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  }, [syncYaml, meta.name]);

  // ── Import from file ──
  const handleFileImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        try {
          const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(text);
          setNodes(newNodes);
          setEdges(newEdges);
          setMeta(() => newMeta);
          setSelectedNode(null);
          setYamlText(text);
          setDryRunResult(null);
          setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
        } catch (err) {
          console.error(err);
          toast.error(`${t("editor.import_file_failed")}: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [setNodes, setEdges, setMeta, setSelectedNode, setYamlText, setDryRunResult, fitView, t],
  );

  // ── Save Draft ──
  const handleSaveDraft = useCallback(async () => {
    if (!workflowId) return;
    const y = syncYaml();
    setSaveStatus("saving");
    try {
      await workflowDefApi.save(workflowId, y);
      setLastSavedYaml(y);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      console.error(err);
      pushWorkflowError("save", (err as Error).message);
      toast.error(`${t("editor.save_failed")}: ${(err as Error).message}`);
      setSaveStatus("idle");
    }
  }, [syncYaml, workflowId, t]);

  // ── Publish ──
  const handlePublish = useCallback(async () => {
    if (!workflowId) return;
    const y = syncYaml();
    setSaveStatus("saving");
    try {
      await workflowDefApi.save(workflowId, y);
      setLastSavedYaml(y);
      setSaveStatus("idle");
    } catch (err) {
      console.error(err);
      toast.error(`${t("editor.save_failed")}: ${(err as Error).message}`);
      setSaveStatus("idle");
      return;
    }

    setPublishing(true);
    try {
      const result = await workflowDefApi.publish(workflowId);
      toast.success(t("editor.published_as", { version: result.version }));
    } catch (err) {
      console.error(err);
      pushWorkflowError("publish", (err as Error).message);
      toast.error(`${t("editor.publish_failed")}: ${(err as Error).message}`);
    } finally {
      setPublishing(false);
    }
  }, [syncYaml, workflowId, t]);

  // ── Cmd+S shortcut ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSaveDraft();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSaveDraft]);

  return {
    syncYaml,
    handleImportYaml,
    handleExportYaml,
    handleFileImport,
    handleSaveDraft,
    handlePublish,
    saveStatus,
    publishing,
  };
}
```

- [ ] **Step 2: 修改 WorkflowEditor.tsx，替换内联持久化逻辑为 hook 调用**

1. 添加 import：`import { useWorkflowPersistence } from "./hooks/useWorkflowPersistence";`
2. 删除行 192-195（lastSavedYaml, saveStatus, publishing 状态声明）
3. 删除行 333-513（syncYaml, handleImportYaml, handleExportYaml, handleFileImport, handleSaveDraft, handlePublish, Cmd+S useEffect）
4. 在 hook 调用区域插入：

```typescript
  // ── Persistence hook ──
  const {
    syncYaml,
    handleImportYaml: importYamlLogic,
    handleExportYaml,
    handleFileImport,
    handleSaveDraft,
    handlePublish,
    saveStatus,
    publishing,
  } = useWorkflowPersistence({
    workflowId,
    meta,
    nodes,
    edges,
    setNodes,
    setEdges,
    fitView,
    yamlOpen,
    yamlText,
    setYamlText,
    setSelectedNode,
    setMeta,
    setDryRunResult,
    activeRunId,
  });

  // handleImportYaml 需要额外处理 yamlOpen 状态切换
  const handleImportYaml = useCallback(() => {
    if (!yamlOpen) {
      syncYaml();
      setYamlOpen(true);
    } else {
      importYamlLogic();
    }
  }, [yamlOpen, syncYaml, setYamlOpen, importYamlLogic]);
```

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/hooks/useWorkflowPersistence.ts web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 提取 useWorkflowPersistence hook"
```

---

### Task 4: 提取 useWorkflowRun

**Files:**
- Create: `web/src/pages/workflow/hooks/useWorkflowRun.ts`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx` (lines 107-124, 515-822 → hook 调用)

**说明:** 最复杂的 hook。包含 dry run、run mode、cancel、approve、back to edit、rerun from、node output、polling。内部持有 dryRunResult、running、runRightTab、nodeOutputLoading、selectedNodeOutput 状态。依赖外部 syncYaml（从 useWorkflowPersistence 返回）。

- [ ] **Step 1: 创建 `web/src/pages/workflow/hooks/useWorkflowRun.ts`**

从 WorkflowEditor.tsx 提取以下逻辑：
- 内部状态：`dryRunResult`（行 108-112）、`running`（行 112）、`runRightTab`（行 122）、`nodeOutputLoading`（行 121）、`selectedNodeOutput`（行 120）
- `handleDryRun`（行 515-530）
- `updateNodesFromSnapshot`（行 534-566）
- `loadRunData`（行 599-618）
- 轮询 useEffect（行 620-636）
- 审批加载 useEffect（行 638-648）
- 节点输出 useEffect（行 650-661）
- `handleRun`（行 663-702）
- `handleCancelRun`（行 704-714）
- `handleApprove`（行 716-731）
- `handleBackToEdit`（行 733-744）
- `handleRerunFrom`（行 746-799）
- `handleViewNodeOutput`（行 801-822）
- `nodeCallbacksRef` 同步（行 824-826）

```typescript
import { type Edge, type Node } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type DAGEvent, type DAGSnapshot, type NodeOutput, type PendingApproval, workflowEngineApi } from "../../../api/workflow-engine";
import { buildRunSummary, pushWorkflowError, clearWorkflowEvents } from "../../../lib/use-workflow-events";
import { START_NODE_ID } from "../yaml-utils";
import { dedupEvents } from "../utils";

export interface UseWorkflowRunParams {
  workflowId: string | undefined;
  nodes: Node[];
  edges: Edge[];
  setNodes: ReturnType<typeof import("@xyflow/react").useNodesState<Node>>[1];
  activeRunId: string | null;
  setActiveRunId: (id: string | null) => void;
  runSnapshot: DAGSnapshot | null;
  setRunSnapshot: (snap: DAGSnapshot | null) => void;
  setRunEvents: (events: DAGEvent[]) => void;
  setRunApprovals: (approvals: PendingApproval[]) => void;
  setSelectedRunNodeId: (id: string | null) => void;
  selectedRunNodeId: string | null;
  syncYaml: () => string;
  fitView: ReturnType<typeof import("@xyflow/react").useReactFlow>["fitView"];
  rightTab: string;
  setRightTab: (tab: "config" | "run" | "versions") => void;
  setSelectedNodeOutput: (output: NodeOutput | null) => void;
  nodeOutputLoading: boolean;
  setNodeOutputLoading: (loading: boolean) => void;
  selectedNodeOutput: NodeOutput | null;
}

export interface UseWorkflowRunReturn {
  handleDryRun: () => Promise<void>;
  handleRun: () => Promise<void>;
  handleCancelRun: () => Promise<void>;
  handleApprove: (approval: PendingApproval) => Promise<void>;
  handleBackToEdit: () => void;
  handleRerunFrom: (nodeId: string) => Promise<void>;
  handleViewNodeOutput: (nodeId: string) => void;
  dryRunResult: { valid: boolean; issues: Array<{ type: string; message: string; field?: string }> } | null;
  running: boolean;
  isRunMode: boolean;
  isRunDone: boolean;
  dagStatus: string | undefined;
  runRightTab: "events" | "output";
  setRunRightTab: (tab: "events" | "output") => void;
  updateNodesFromSnapshot: (snap: DAGSnapshot) => void;
  loadRunData: (runId: string) => Promise<void>;
}

export function useWorkflowRun(params: UseWorkflowRunParams): UseWorkflowRunReturn {
  const {
    workflowId,
    nodes,
    edges,
    setNodes,
    activeRunId,
    setActiveRunId,
    runSnapshot,
    setRunSnapshot,
    setRunEvents,
    setRunApprovals,
    setSelectedRunNodeId,
    selectedRunNodeId,
    syncYaml,
    fitView,
    rightTab,
    setRightTab,
    setSelectedNodeOutput,
    setNodeOutputLoading,
    selectedNodeOutput,
  } = params;

  const { t } = useTranslation("workflows");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nodeCallbacksRef = useRef<{
    onViewOutput: (nodeId: string) => void;
    onRerunFrom: (fromNodeId: string) => void;
  }>({ onViewOutput: () => {}, onRerunFrom: () => {} });

  const [dryRunResult, setDryRunResult] = useState<{
    valid: boolean;
    issues: Array<{ type: string; message: string; field?: string }>;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [runRightTab, setRunRightTab] = useState<"events" | "output">("events");

  const isRunMode = activeRunId !== null;
  const dagStatus = runSnapshot?.dag_status;
  const isRunDone = dagStatus ? ["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(dagStatus) : false;

  // ── Dry Run ──
  const handleDryRun = useCallback(async () => {
    const y = syncYaml();
    setRunning(true);
    setDryRunResult(null);
    try {
      const result = await workflowEngineApi.dryRun(y);
      setDryRunResult(result);
    } catch (err) {
      console.error(err);
      pushWorkflowError("validation", (err as Error).message);
      setDryRunResult({ valid: false, issues: [{ type: "error", message: (err as Error).message }] });
    } finally {
      setRunning(false);
    }
  }, [syncYaml]);

  // ── Run mode helpers ──
  const updateNodesFromSnapshot = useCallback(
    (snap: DAGSnapshot) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === START_NODE_ID) return n;
          const state = snap.node_states[n.id];
          if (!state)
            return {
              ...n,
              data: {
                ...n.data,
                _runStatus: undefined,
                _exitCode: undefined,
                _onViewOutput: undefined,
                _onRerunFrom: undefined,
              },
            };
          return {
            ...n,
            data: {
              ...n.data,
              _runStatus: state.status,
              _exitCode: state.exit_code,
              _onViewOutput: nodeCallbacksRef.current.onViewOutput,
              _onRerunFrom: nodeCallbacksRef.current.onRerunFrom,
            },
          };
        }),
      );
    },
    [setNodes],
  );

  // Keep a stable ref to updateNodesFromSnapshot
  const updateNodesFromSnapshotRef = useRef(updateNodesFromSnapshot);
  updateNodesFromSnapshotRef.current = updateNodesFromSnapshot;

  const loadRunData = useCallback(
    async (runId: string) => {
      try {
        const [snap, evts] = await Promise.all([
          workflowEngineApi.getRunStatus(runId),
          workflowEngineApi.getEvents(runId),
        ]);
        if (snap) {
          setRunSnapshot(snap);
          updateNodesFromSnapshotRef.current(snap);
          const { buildRunSummary: brs } = await import("../../../lib/use-workflow-events");
          const { pushWorkflowRunStatus } = await import("../../../lib/use-workflow-events");
          pushWorkflowRunStatus(brs(snap));
        }
        if (Array.isArray(evts)) setRunEvents(dedupEvents(evts));
      } catch (err) {
        console.error(err);
      }
    },
    [setRunSnapshot, setRunEvents],
  );

  // 轮询运行中的工作流
  useEffect(() => {
    if (!activeRunId || !runSnapshot) return;
    const status = runSnapshot.dag_status;
    if (["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(status)) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      await loadRunData(activeRunId);
      if (!cancelled) pollRef.current = setTimeout(poll, 2000);
    };
    pollRef.current = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [activeRunId, runSnapshot, loadRunData]);

  // SUSPENDED 时加载审批列表
  useEffect(() => {
    if (!activeRunId || !runSnapshot || runSnapshot.dag_status !== "SUSPENDED") {
      setRunApprovals([]);
      return;
    }
    workflowEngineApi
      .getPendingApprovals(activeRunId)
      .then((list) => setRunApprovals(Array.isArray(list) ? list : []))
      .catch((err) => console.error(err));
  }, [activeRunId, runSnapshot, setRunApprovals]);

  // 选中节点 → 加载输出
  useEffect(() => {
    if (!activeRunId || !selectedRunNodeId) return;
    setNodeOutputLoading(true);
    setSelectedNodeOutput(null);
    setRunRightTab("output");
    workflowEngineApi
      .getOutput(activeRunId, selectedRunNodeId)
      .then((out) => setSelectedNodeOutput(out ?? null))
      .catch((err) => console.error(err))
      .finally(() => setNodeOutputLoading(false));
  }, [activeRunId, selectedRunNodeId, setSelectedNodeOutput, setNodeOutputLoading]);

  // ── Run workflow ──
  const handleRun = useCallback(async () => {
    const y = syncYaml();
    setRunning(true);
    setDryRunResult(null);
    clearWorkflowEvents();

    if (workflowId) {
      try {
        const { workflowDefApi } = await import("../../../api/workflow-defs");
        await workflowDefApi.save(workflowId, y);
      } catch (err) {
        console.error(`${t("editor.auto_save_failed")}:`, err);
      }
    }

    setNodes((nds) =>
      nds.map((n) =>
        n.id === START_NODE_ID ? n : { ...n, data: { ...n.data, _runStatus: "RUNNING", _exitCode: undefined } },
      ),
    );

    try {
      const result = await workflowEngineApi.run(y, undefined, workflowId);
      setActiveRunId(result.runId);
      setRunSnapshot(null);
      setRunEvents([]);
      setRunApprovals([]);
      setSelectedRunNodeId(null);
      setSelectedNodeOutput(null);
      setRightTab("run");
      await loadRunData(result.runId);
    } catch (err) {
      console.error(err);
      pushWorkflowError("run", (err as Error).message);
      toast.error(`${t("editor.run_failed")}: ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [syncYaml, workflowId, setNodes, setActiveRunId, setRunSnapshot, setRunEvents, setRunApprovals, setSelectedRunNodeId, setSelectedNodeOutput, setRightTab, loadRunData, t]);

  // ── Cancel run ──
  const handleCancelRun = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await workflowEngineApi.cancel(activeRunId);
      await loadRunData(activeRunId);
    } catch (err) {
      console.error(err);
      toast.error((err as Error).message);
    }
  }, [activeRunId, loadRunData]);

  // ── Approve ──
  const handleApprove = useCallback(
    async (approval: PendingApproval) => {
      if (!activeRunId) return;
      try {
        await workflowEngineApi.approve(activeRunId, approval.nodeId, approval.approvalToken);
        await loadRunData(activeRunId);
        const list = await workflowEngineApi.getPendingApprovals(activeRunId);
        setRunApprovals(Array.isArray(list) ? list : []);
      } catch (err) {
        console.error(err);
        toast.error((err as Error).message);
      }
    },
    [activeRunId, loadRunData, setRunApprovals],
  );

  // ── Back to edit ──
  const handleBackToEdit = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setActiveRunId(null);
    setRunSnapshot(null);
    setRunEvents([]);
    setRunApprovals([]);
    setSelectedRunNodeId(null);
    setSelectedNodeOutput(null);
    setRightTab("config");
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, _runStatus: undefined, _exitCode: undefined } })));
  }, [setActiveRunId, setRunSnapshot, setRunEvents, setRunApprovals, setSelectedRunNodeId, setSelectedNodeOutput, setRightTab, setNodes]);

  // ── Rerun from selected node ──
  const handleRerunFrom = useCallback(
    async (fromNodeId: string) => {
      if (!activeRunId) return;
      const y = syncYaml();
      setRunning(true);
      setNodes((nds) => {
        const downstream = new Set<string>();
        const adjMap = new Map<string, string[]>();
        for (const e of edges) {
          if (e.source === START_NODE_ID) continue;
          const list = adjMap.get(e.source) ?? [];
          list.push(e.target);
          adjMap.set(e.source, list);
        }
        const q = [fromNodeId];
        while (q.length > 0) {
          const cur = q.shift()!;
          for (const next of adjMap.get(cur) ?? []) {
            if (!downstream.has(next)) {
              downstream.add(next);
              q.push(next);
            }
          }
        }
        return nds.map((n) => {
          if (n.id === START_NODE_ID) return n;
          const isTarget = n.id === fromNodeId || downstream.has(n.id);
          if (isTarget) return { ...n, data: { ...n.data, _runStatus: "RUNNING", _exitCode: undefined } };
          return n;
        });
      });

      try {
        const result = await workflowEngineApi.rerunFrom(activeRunId, y, fromNodeId, workflowId);
        setActiveRunId(result.runId);
        setRunSnapshot(null);
        setRunEvents([]);
        setRunApprovals([]);
        setSelectedRunNodeId(null);
        setSelectedNodeOutput(null);
        setRightTab("run");
        await loadRunData(result.runId);
      } catch (err) {
        console.error(err);
        toast.error(`${t("editor.rerun_failed")}: ${(err as Error).message}`);
      } finally {
        setRunning(false);
      }
    },
    [activeRunId, syncYaml, workflowId, edges, setNodes, setActiveRunId, setRunSnapshot, setRunEvents, setRunApprovals, setSelectedRunNodeId, setSelectedNodeOutput, setRightTab, loadRunData, t],
  );

  // ── View node output ──
  const handleViewNodeOutput = useCallback(
    async (nodeId: string) => {
      if (!activeRunId) return;
      setSelectedRunNodeId(nodeId);
      setRunRightTab("output");
      setNodeOutputLoading(true);
      setSelectedNodeOutput(null);
      setRightTab("run");
      try {
        const out = await workflowEngineApi.getOutput(activeRunId, nodeId);
        setSelectedNodeOutput(out ?? null);
      } catch (err) {
        console.error(err);
        setSelectedNodeOutput(null);
      } finally {
        setNodeOutputLoading(false);
      }
    },
    [activeRunId, setSelectedRunNodeId, setNodeOutputLoading, setSelectedNodeOutput, setRightTab],
  );

  // 保持 ref 同步
  nodeCallbacksRef.current.onViewOutput = handleViewNodeOutput;
  nodeCallbacksRef.current.onRerunFrom = handleRerunFrom;

  return {
    handleDryRun,
    handleRun,
    handleCancelRun,
    handleApprove,
    handleBackToEdit,
    handleRerunFrom,
    handleViewNodeOutput,
    dryRunResult,
    running,
    isRunMode,
    isRunDone,
    dagStatus,
    runRightTab,
    setRunRightTab,
    updateNodesFromSnapshot,
    loadRunData,
  };
}
```

- [ ] **Step 2: 创建 `web/src/pages/workflow/utils.ts` — 提取共享工具函数**

从 WorkflowEditor.tsx 底部提取 `dedupEvents` 函数（行 2194-2202）：

```typescript
import type { DAGEvent } from "../../api/workflow-engine";

export function dedupEvents(events: DAGEvent[]): DAGEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (seen.has(e.event_id)) return false;
    seen.add(e.event_id);
    return true;
  });
}
```

- [ ] **Step 3: 修改 WorkflowEditor.tsx，替换内联运行逻辑为 hook 调用**

1. 添加 import：`import { useWorkflowRun } from "./hooks/useWorkflowRun";` 和 `import { dedupEvents } from "./utils";`
2. 删除行 107-124（dryRun/run 状态声明）
3. 删除行 124（pollRef）
4. 删除行 184（nodeCallbacksRef）
5. 删除行 515-826（所有运行逻辑）
6. 在 hook 调用区域插入：

```typescript
  // ── Run 状态（保留在 WorkflowEditorInner，由 hook 和 JSX 共享） ──
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runSnapshot, setRunSnapshot] = useState<DAGSnapshot | null>(null);
  const [runEvents, setRunEvents] = useState<DAGEvent[]>([]);
  const [runApprovals, setRunApprovals] = useState<PendingApproval[]>([]);
  const [selectedRunNodeId, setSelectedRunNodeId] = useState<string | null>(null);
  const [selectedNodeOutput, setSelectedNodeOutput] = useState<NodeOutput | null>(null);
  const [nodeOutputLoading, setNodeOutputLoading] = useState(false);

  // ── Run hook ──
  const {
    handleDryRun,
    handleRun,
    handleCancelRun,
    handleApprove,
    handleBackToEdit,
    handleRerunFrom,
    handleViewNodeOutput,
    dryRunResult,
    running,
    isRunMode,
    isRunDone,
    dagStatus,
    runRightTab,
    setRunRightTab,
    updateNodesFromSnapshot,
    loadRunData,
  } = useWorkflowRun({
    workflowId,
    nodes,
    edges,
    setNodes,
    activeRunId,
    setActiveRunId,
    runSnapshot,
    setRunSnapshot,
    setRunEvents,
    setRunApprovals,
    setSelectedRunNodeId,
    selectedRunNodeId,
    syncYaml,
    fitView,
    rightTab,
    setRightTab,
    setSelectedNodeOutput,
    nodeOutputLoading,
    setNodeOutputLoading,
    selectedNodeOutput,
  });
```

- [ ] **Step 4: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/workflow/hooks/useWorkflowRun.ts web/src/pages/workflow/utils.ts web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 提取 useWorkflowRun hook + 共享 utils"
```

---

### Task 5: 清理 WorkflowEditorInner 剩余内联逻辑

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

**说明:** 4 个 hook 都已提取完成。现在需要清理 WorkflowEditorInner 中残留的内联逻辑，确保：
1. 所有原内联代码已被 hook 调用替代
2. `isRunMode`/`dagStatus`/`isRunDone` 不再重复声明（由 useWorkflowRun 提供）
3. `updateNodesFromSnapshotRef` 不再需要（在 hook 内部）
4. 删除 `dedupEvents` 的原始定义（已移到 utils.ts）
5. 草稿加载 useEffect（行 197-218）和运行历史加载 useEffect（行 220-251）保留在 WorkflowEditorInner

- [ ] **Step 1: 检查并清理重复声明**

确认以下变量已从 WorkflowEditorInner 顶层删除（由 hook 返回）：
- `dryRunResult`, `running` → useWorkflowRun
- `saveStatus`, `publishing` → useWorkflowPersistence
- `chatOpen`, `metaAgentId`, `agentList`, `agentOverrideOpen` → useWorkflowMetaAgent
- `scenePrompt` → useWorkflowMetaAgent
- `isRunMode`, `dagStatus`, `isRunDone` → useWorkflowRun
- `pollRef`, `nodeCallbacksRef` → useWorkflowRun 内部

确认以下变量仍保留在 WorkflowEditorInner：
- `meta`, `setMeta` — 传给多个 hook
- `selectedNode`, `setSelectedNode` — 传给 Canvas hook 和 JSX
- `yamlOpen`, `yamlText`, `readOnly` — 传给 Persistence hook 和 JSX
- `activeRunId` 等 run 状态 — 传给 Run hook 和 JSX
- `rightTab`, `setRightTab` — 传给 Run hook 和 JSX
- `fileInputRef` — JSX 直接使用
- `updateNodesFromSnapshot` — 草稿加载 useEffect 和运行历史 useEffect 使用

- [ ] **Step 2: 更新 runId 历史加载 useEffect**

行 220-251 的 useEffect 使用了 `updateNodesFromSnapshotRef`。改为直接使用 hook 返回的 `updateNodesFromSnapshot`：

```typescript
  useEffect(() => {
    if (!runId) return;
    let abort = false;
    (async () => {
      try {
        setActiveRunId(runId);
        setRunSnapshot(null);
        setRunEvents([]);
        setRunApprovals([]);
        setSelectedRunNodeId(null);
        setSelectedNodeOutput(null);
        setRightTab("run");

        const [snap, evts] = await Promise.all([
          workflowEngineApi.getRunStatus(runId),
          workflowEngineApi.getEvents(runId),
        ]);
        if (abort) return;
        if (snap) {
          setRunSnapshot(snap);
          updateNodesFromSnapshot(snap);
        }
        if (Array.isArray(evts)) setRunEvents(dedupEvents(evts));
      } catch (err) {
        console.error(`${t("editor.load_run_failed")}:`, err);
      }
    })();
    return () => {
      abort = true;
    };
  }, [runId, t, setActiveRunId, setRunSnapshot, setRunEvents, setRunApprovals, setSelectedRunNodeId, setSelectedNodeOutput, setRightTab, updateNodesFromSnapshot]);
```

- [ ] **Step 3: 更新 RunListPanel onSelect 回调**

行 2103-2126 的 RunListPanel onSelect 使用了 `updateNodesFromSnapshot`。确认改为使用 hook 返回的值。

- [ ] **Step 4: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 清理 WorkflowEditorInner，完成 hook 拆分"
```

---

### Task 6: Full precheck 验证

**Files:** 无新增，验证所有已有文件

- [ ] **Step 1: 运行 precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: 全部通过（格式化 + import 排序 + tsc + biome check）

- [ ] **Step 2: 运行前端测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/`
Expected: 所有测试通过

- [ ] **Step 3: 运行后端测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/`
Expected: 所有测试通过

- [ ] **Step 4: 如果 precheck 有自动修复，确认修复后重新 precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: 全部通过

- [ ] **Step 5: 最终提交**

```bash
git add -A
git commit -m "refactor: WorkflowEditor Phase 1 hook 拆分完成"
```

---

## 重构后 WorkflowEditorInner 结构预估

```
WorkflowEditorInner (~400-500 行)
  ├─ useState 声明 (~30 行)
  │   meta, selectedNode, yamlOpen, yamlText, readOnly,
  │   activeRunId, runSnapshot, runEvents, runApprovals,
  │   selectedRunNodeId, selectedNodeOutput, nodeOutputLoading,
  │   rightTab, fileInputRef
  ├─ useWorkflowMetaAgent 调用 (~5 行)
  ├─ useWorkflowCanvas 调用 (~15 行)
  ├─ useWorkflowPersistence 调用 (~15 行)
  ├─ useWorkflowRun 调用 (~25 行)
  ├─ 派生状态 (sd, nodeType, isStartNode, onSelectionChange 包装) (~10 行)
  ├─ 数据加载 useEffect (草稿加载 + 运行历史加载) (~60 行)
  ├─ 辅助: handleRefreshDraft, updateMeta, handleImportYaml wrapper (~40 行)
  ├─ PALETTE_ITEMS 常量 (~10 行)
  └─ JSX 渲染 (~200-300 行，Phase 2 拆分)
```
