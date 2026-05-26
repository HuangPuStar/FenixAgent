# WorkflowEditor 重构设计 — 阶段 1：Hook 拆分

> 日期：2026-05-25
> 状态：已确认，待实现

## 背景

`WorkflowEditor.tsx` 已达 2886 行，包含画布交互、保存发布、运行模式、Meta Agent 集成等多个职责。代码难以阅读和维护，单次编辑风险高。

## 目标

将 WorkflowEditor 的逻辑拆分为 4 个自定义 hook，每个 hook 负责一个独立职责。状态留在 WorkflowEditor 顶层，通过参数传递给 hook。JSX 渲染暂不动（阶段 2 处理）。

## 设计决策

| 维度 | 决策 | 理由 |
|------|------|------|
| 状态管理 | 留在 WorkflowEditor 顶层，通过 props 传给 hook | 最简单、无循环依赖、易测试 |
| Hook 数量 | 4 个 | 按职责边界划分，粒度适中 |
| JSX 拆分 | 阶段 2 | 先拆逻辑，降低风险 |
| 文件位置 | `web/src/pages/workflow/hooks/` | 与 WorkflowEditor 同目录，就近组织 |

## Hook 设计

### 1. `useWorkflowCanvas` — 画布交互

**文件**：`web/src/pages/workflow/hooks/useWorkflowCanvas.ts`

**输入**：
```typescript
interface UseWorkflowCanvasParams {
  nodes: Node[];
  edges: Edge[];
  setNodes: ReturnType<typeof useNodesState>[1];
  setEdges: ReturnType<typeof useEdgesState>[1];
  readOnly: boolean;
  activeRunId: string | null;
  screenToFlowPosition: ReturnType<typeof useReactFlow>["screenToFlowPosition"];
  selectedNode: Node | null;
}
```

**返回**：
```typescript
interface UseWorkflowCanvasReturn {
  onSelectionChange: OnSelectionChangeFunc;
  onConnect: (connection: Connection) => void;
  onConnectStart: (event: MouseEvent | TouchEvent) => void;
  onConnectEnd: (event: MouseEvent | TouchEvent) => void;
  handleNodesDelete: (nodes: Node[]) => void;
  addNode: (type: string, position: XYPosition) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  updateNodeData: (data: Record<string, unknown>) => void;
  handleIdChange: (newId: string) => void;
}
```

**对应原代码**：253-261, 264-330, 340-372, 827-861 行

### 2. `useWorkflowPersistence` — 保存/发布/YAML 同步

**文件**：`web/src/pages/workflow/hooks/useWorkflowPersistence.ts`

**输入**：
```typescript
interface UseWorkflowPersistenceParams {
  workflowId: string | undefined;
  meta: WfMeta;
  nodes: Node[];
  edges: Edge[];
  setNodes: ReturnType<typeof useNodesState>[1];
  setEdges: ReturnType<typeof useEdgesState>[1];
  fitView: ReturnType<typeof useReactFlow>["fitView"];
  yamlOpen: boolean;
  yamlText: string;
  setYamlText: (text: string) => void;
  activeRunId: string | null;
  updateNodesFromSnapshot: (snap: DAGSnapshot) => void;
}
```

**返回**：
```typescript
interface UseWorkflowPersistenceReturn {
  syncYaml: () => string;
  handleSaveDraft: () => Promise<void>;
  handlePublish: () => Promise<void>;
  handleRefreshDraft: () => Promise<void>;
  handleImportYaml: () => void;
  handleExportYaml: () => void;
  handleFileImport: () => void;
  saveStatus: "idle" | "saving" | "saved";
  publishing: boolean;
  lastSavedYaml: string;
  setLastSavedYaml: (yaml: string) => void;
}
```

**内部持有状态**：`saveStatus`, `publishing`, `lastSavedYaml`

**对应原代码**：333-337, 393-453, 456-510, 572-596, 192-194 行

### 3. `useWorkflowRun` — 运行模式

**文件**：`web/src/pages/workflow/hooks/useWorkflowRun.ts`

**输入**：
```typescript
interface UseWorkflowRunParams {
  workflowId: string | undefined;
  nodes: Node[];
  edges: Edge[];
  setNodes: ReturnType<typeof useNodesState>[1];
  activeRunId: string | null;
  setActiveRunId: (id: string | null) => void;
  runSnapshot: DAGSnapshot | null;
  setRunSnapshot: (snap: DAGSnapshot | null) => void;
  setRunEvents: (events: DAGEvent[]) => void;
  setRunApprovals: (approvals: PendingApproval[]) => void;
  setSelectedRunNodeId: (id: string | null) => void;
  selectedRunNodeId: string | null;
  setSelectedNodeOutput: (output: NodeOutput | null) => void;
  syncYaml: () => string;
  fitView: ReturnType<typeof useReactFlow>["fitView"];
  rightTab: string;
  setRightTab: (tab: string) => void;
}
```

**返回**：
```typescript
interface UseWorkflowRunReturn {
  handleDryRun: () => Promise<void>;
  handleRun: () => Promise<void>;
  handleCancelRun: () => Promise<void>;
  handleApprove: (approval: PendingApproval) => Promise<void>;
  handleBackToEdit: () => void;
  handleRerunFrom: (nodeId: string) => Promise<void>;
  handleViewNodeOutput: (nodeId: string) => void;
  dryRunResult: { valid: boolean; issues: Array<{ type: string; message: string }> } | null;
  running: boolean;
  isRunMode: boolean;
  isRunDone: boolean;
  dagStatus: string | undefined;
  nodeOutputLoading: boolean;
  selectedNodeOutput: NodeOutput | null;
  runRightTab: "events" | "output";
  setRunRightTab: (tab: "events" | "output") => void;
  updateNodesFromSnapshot: (snap: DAGSnapshot) => void;
}
```

**内部持有状态**：`dryRunResult`, `running`, `runRightTab`, `nodeOutputLoading`, `selectedNodeOutput`

**包含 useEffect**：轮询(620-635)、审批加载(638-647)、节点输出加载(650-660)

**对应原代码**：107-121, 515-660, 663-820 行

### 4. `useWorkflowMetaAgent` — Meta Agent 集成

**文件**：`web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts`

**输入**：
```typescript
interface UseWorkflowMetaAgentParams {
  workflowId: string | undefined;
  meta: WfMeta;
}
```

**返回**：
```typescript
interface UseWorkflowMetaAgentReturn {
  scenePrompt: string | undefined;
  chatOpen: boolean;
  setChatOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  metaAgentId: string | null;
  agentList: Array<{ name: string; model: string | null; description: string | null }>;
  agentOverrideOpen: boolean;
  setAgentOverrideOpen: (open: boolean) => void;
}
```

**内部持有状态**：`chatOpen`, `metaAgentId`, `agentList`, `agentOverrideOpen`

**包含 useEffect**：chat 状态持久化(147-154)、agent 列表加载(162-177)

**对应原代码**：126-177, 134-145 行

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `web/src/pages/workflow/hooks/useWorkflowCanvas.ts` | 新建 | 画布交互 hook |
| `web/src/pages/workflow/hooks/useWorkflowPersistence.ts` | 新建 | 保存/发布 hook |
| `web/src/pages/workflow/hooks/useWorkflowRun.ts` | 新建 | 运行模式 hook |
| `web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts` | 新建 | Meta Agent hook |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 修改 | 替换内联逻辑为 hook 调用 |

## 重构后 WorkflowEditor 结构预估

```
WorkflowEditorInner (~800-1000 行)
  ├─ useState 声明 (~20 行)
  ├─ useWorkflowCanvas 调用 (~5 行)
  ├─ useWorkflowPersistence 调用 (~5 行)
  ├─ useWorkflowRun 调用 (~10 行)
  ├─ useWorkflowMetaAgent 调用 (~3 行)
  ├─ 派生状态和少量内联逻辑 (~30 行)
  ├─ 数据加载 useEffect (~50 行)
  ├─ 辅助函数 (dedupEvents, relativeTime 等) (~60 行)
  └─ JSX 渲染 (~600-800 行，阶段 2 拆分)
```

## 边界情况

- **循环依赖**：hook 之间不直接依赖，都通过 WorkflowEditor 传参。例如 `useWorkflowRun` 需要 `syncYaml`（来自 `useWorkflowPersistence`）和 `updateNodesFromSnapshot`（`useWorkflowRun` 自身提供），WorkflowEditor 负责连接。
- **useEffect 顺序**：React hook 调用顺序必须稳定。4 个 hook 的 useEffect 注册顺序不影响功能（React 保证同一渲染周期内所有 effect 在渲染后按序执行）。
- **t (i18n)**：各 hook 需要独立调用 `useTranslation()`，因为 hook 是在组件内执行的。
- **测试**：hook 可通过简单的包装组件测试，或提取纯函数部分单独测试。

## 阶段 2 预告（本次不实现）

JSX 子组件拆分：
- `NodeConfigPanel` (~525 行)
- `RunStatusPanel` (~350 行)
- `WorkflowToolbar` (~130 行)
- `YamlSlidePanel` (~30 行)
- `MetaAgentPanel` (~50 行)
