# WorkflowEditor 重构设计 — 阶段 2：JSX 子组件拆分

> 日期：2026-05-25
> 状态：已确认，待实现
> 前置依赖：阶段 1（Hook 拆分）

## 背景

阶段 1 将逻辑拆分到 4 个自定义 hook 后，WorkflowEditor 的 JSX 渲染部分仍占 ~800 行。阶段 2 将 JSX 拆分为 5 个独立子组件。

## 目标

将 WorkflowEditor 的 JSX 渲染部分拆分为 5 个子组件，每个组件负责一个独立的 UI 区域。WorkflowEditor 只负责组合子组件和传递 props。

## 设计决策

| 维度 | 决策 | 理由 |
|------|------|------|
| 目录 | `web/src/pages/workflow/components/` | 与 hooks 同级，就近组织 |
| Props 传递 | 从 WorkflowEditor 直接传 props | 不引入 Context，保持简单 |
| 状态管理 | 子组件不持有新状态，纯展示 + 回调 | 状态已在顶层 + hooks |
| i18n | 各组件自行 `useTranslation()` | 遵循项目现有模式 |

## 组件设计

### 1. `NodeConfigPanel`

**文件**：`web/src/pages/workflow/components/NodeConfigPanel.tsx`

**职责**：右侧面板"配置"tab — 节点属性编辑（所有节点类型）+ 工作流元数据编辑

**Props**：
```typescript
interface NodeConfigPanelProps {
  selectedNode: Node | null;
  nodes: Node[];
  edges: Edge[];
  readOnly: boolean;
  updateNodeData: (data: Record<string, unknown>) => void;
  handleIdChange: (newId: string) => void;
  meta: WfMeta;
  updateMeta: (meta: Partial<WfMeta>) => void;
  agentList: Array<{ name: string; model: string | null; description: string | null }>;
  agentOverrideOpen: boolean;
  setAgentOverrideOpen: (open: boolean) => void;
}
```

**来源行**：1253-1778（~525 行）

**内部结构**：
- 只读提示
- 无选中节点时显示工作流元数据编辑
- 选中节点时显示节点配置表单（按类型分支：shell/python/agent/api/audit/workflow/loop）
- 节点 ID 编辑
- 节点高级配置（depends_on、inputs）

### 2. `RunStatusPanel`

**文件**：`web/src/pages/workflow/components/RunStatusPanel.tsx`

**职责**：右侧面板"运行"tab — 运行状态、审批、事件、输出、历史运行

**Props**：
```typescript
interface RunStatusPanelProps {
  activeRunId: string | null;
  runSnapshot: DAGSnapshot | null;
  runEvents: DAGEvent[];
  runApprovals: PendingApproval[];
  running: boolean;
  dagStatus: string | undefined;
  selectedRunNodeId: string | null;
  selectedNodeOutput: NodeOutput | null;
  nodeOutputLoading: boolean;
  runRightTab: "events" | "output";
  setRunRightTab: (tab: "events" | "output") => void;
  handleCancelRun: () => Promise<void>;
  handleApprove: (approval: PendingApproval) => Promise<void>;
  handleRerunFrom: (nodeId: string) => Promise<void>;
  setSelectedRunNodeId: (id: string | null) => void;
  workflowId: string | undefined;
}
```

**来源行**：1778-2128（~350 行）

**内部结构**：
- 运行状态头（状态徽章 + 操作按钮）
- 审批卡片
- 进度条
- 事件/输出子 tab
- 事件列表
- 节点输出查看
- 历史运行列表（复用 `RunListPanel`）

### 3. `WorkflowToolbar`

**文件**：`web/src/pages/workflow/components/WorkflowToolbar.tsx`

**职责**：ReactFlow 顶部工具栏 — 所有工具按钮和 tab 切换

**Props**：
```typescript
interface WorkflowToolbarProps {
  isRunMode: boolean;
  isRunDone: boolean;
  running: boolean;
  saveStatus: "idle" | "saving" | "saved";
  publishing: boolean;
  yamlOpen: boolean;
  chatOpen: boolean;
  rightTab: "config" | "run" | "versions";
  readOnly: boolean;
  dagStatus: string | undefined;
  handleNew: () => void;
  handleSaveDraft: () => Promise<void>;
  handlePublish: () => Promise<void>;
  handleDryRun: () => Promise<void>;
  handleRun: () => Promise<void>;
  handleCancelRun: () => Promise<void>;
  handleAutoLayout: () => void;
  handleExportYaml: () => void;
  handleFileImport: () => void;
  handleBackToEdit: () => void;
  setYamlOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setChatOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setRightTab: (tab: "config" | "run" | "versions") => void;
  syncYaml: () => string;
}
```

**来源行**：961-1090（~130 行）

### 4. `YamlSlidePanel`

**文件**：`web/src/pages/workflow/components/YamlSlidePanel.tsx`

**职责**：YAML 编辑器滑出面板

**Props**：
```typescript
interface YamlSlidePanelProps {
  yamlOpen: boolean;
  yamlText: string;
  setYamlText: (text: string) => void;
  setNodes: ReturnType<typeof useNodesState>[1];
  setEdges: ReturnType<typeof useEdgesState>[1];
  syncYaml: () => string;
  fitView: ReturnType<typeof useReactFlow>["fitView"];
}
```

**来源行**：1192-1220（~30 行）

### 5. `MetaAgentPanel`

**文件**：`web/src/pages/workflow/components/MetaAgentPanel.tsx`

**职责**：Meta Agent 聊天侧边栏

**Props**：
```typescript
interface MetaAgentPanelProps {
  chatOpen: boolean;
  metaAgentId: string | null;
  scenePrompt: string | undefined;
}
```

**来源行**：2139-2188（~50 行）

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `web/src/pages/workflow/components/NodeConfigPanel.tsx` | 新建 | 节点配置面板 |
| `web/src/pages/workflow/components/RunStatusPanel.tsx` | 新建 | 运行状态面板 |
| `web/src/pages/workflow/components/WorkflowToolbar.tsx` | 新建 | 工具栏 |
| `web/src/pages/workflow/components/YamlSlidePanel.tsx` | 新建 | YAML 编辑面板 |
| `web/src/pages/workflow/components/MetaAgentPanel.tsx` | 新建 | Meta Agent 面板 |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 修改 | 替换内联 JSX 为子组件调用 |

## 重构后 WorkflowEditor 结构预估

```
WorkflowEditorInner (~200-300 行)
  ├─ useState 声明 (~20 行)
  ├─ 4 个 hook 调用 (~20 行)
  ├─ 派生状态和少量内联逻辑 (~30 行)
  ├─ 数据加载 useEffect (~50 行)
  ├─ 辅助函数 (~60 行)
  └─ JSX 渲染 (~50-100 行，纯组合子组件)
```

## 边界情况

- **NodeConfigPanel 内的节点类型分支**：525 行的表单逻辑原样迁移为组件内部渲染，不做进一步拆分（避免过度抽象）。
- **RunStatusPanel 内的 EventIcon**：`EventIcon` 辅助组件已定义在 WorkflowEditor 底部，迁移到 RunStatusPanel 文件内部或独立文件。
- **VersionPanel / RunListPanel / NodeOutputView**：这三个已在文件底部定义为独立函数组件，只需移到 `components/` 目录，无需重写。
- **辅助函数**（`dedupEvents`, `relativeTime`, `formatEventType`, `formatMeta`）：移到 `web/src/pages/workflow/utils.ts`，被多个组件共享。

## 实施顺序

1. 先创建 `components/` 目录
2. 迁移辅助函数到 `utils.ts`
3. 迁移 `VersionPanel`、`RunListPanel`、`NodeOutputView` 到 `components/`
4. 按顺序拆出 5 个新组件（从大到小：NodeConfigPanel → RunStatusPanel → WorkflowToolbar → MetaAgentPanel → YamlSlidePanel）
5. 每拆一个组件后验证编译通过
