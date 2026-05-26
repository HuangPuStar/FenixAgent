# WorkflowEditor 重构 Phase 2：JSX 子组件拆分 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 WorkflowEditor 的 JSX 渲染部分拆分为 5 个独立子组件，WorkflowEditor 只负责组合子组件和传递 props。

**Architecture:** 5 个子组件（NodeConfigPanel、RunStatusPanel、WorkflowToolbar、YamlSlidePanel、MetaAgentPanel）+ 3 个已有独立组件迁移（VersionPanel、RunListPanel、NodeOutputView）。所有组件纯展示 + 回调，不引入 Context，状态留在 WorkflowEditor 顶层。

**Tech Stack:** React 19, TypeScript, react-i18next, lucide-react, @xyflow/react

**前置依赖：** Phase 1（Hook 拆分）已完成

---

## 文件结构

| 文件 | 操作 | 说明 |
|------|------|------|
| `web/src/pages/workflow/utils.ts` | 修改 | 添加共享工具函数（Phase 1 已创建 dedupEvents） |
| `web/src/pages/workflow/components/VersionPanel.tsx` | 新建 | 版本管理面板（从 WorkflowEditor 底部迁移） |
| `web/src/pages/workflow/components/RunListPanel.tsx` | 新建 | 历史运行列表（从 WorkflowEditor 底部迁移） |
| `web/src/pages/workflow/components/NodeOutputView.tsx` | 新建 | 节点输出查看（从 WorkflowEditor 底部迁移） |
| `web/src/pages/workflow/components/NodeConfigPanel.tsx` | 新建 | 节点配置面板（~525 行） |
| `web/src/pages/workflow/components/RunStatusPanel.tsx` | 新建 | 运行状态面板（~350 行） |
| `web/src/pages/workflow/components/WorkflowToolbar.tsx` | 新建 | 工具栏（~130 行） |
| `web/src/pages/workflow/components/YamlSlidePanel.tsx` | 新建 | YAML 编辑面板（~30 行） |
| `web/src/pages/workflow/components/MetaAgentPanel.tsx` | 新建 | Meta Agent 面板（~50 行） |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 修改 | 替换内联 JSX 为子组件调用 |

---

### Task 1: 扩展 utils.ts — 迁移共享工具函数

**Files:**
- Modify: `web/src/pages/workflow/utils.ts`（Phase 1 已创建，含 dedupEvents）
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`（删除原内联定义，改为 import）

**说明:** 将 WorkflowEditor 底部的工具函数和常量迁移到 utils.ts，供多个组件共享。

- [ ] **Step 1: 在 `web/src/pages/workflow/utils.ts` 中添加以下内容**

Phase 1 已创建此文件并含 `dedupEvents`。现在追加：

```typescript
// ── DAG 状态样式配置 ──
export const DAG_STATUS_CFG: Record<string, { color: string; bg: string; labelKey: string }> = {
  PENDING: { color: "#94a3b8", bg: "#f1f5f9", labelKey: "editor.dag_status_pending" },
  RUNNING: { color: "#3b82f6", bg: "#eff6ff", labelKey: "editor.dag_status_running" },
  SUSPENDED: { color: "#f59e0b", bg: "#fffbeb", labelKey: "editor.dag_status_suspended" },
  SUCCESS: { color: "#22c55e", bg: "#f0fdf4", labelKey: "editor.dag_status_success" },
  FAILED: { color: "#ef4444", bg: "#fef2f2", labelKey: "editor.dag_status_failed" },
  CANCELLED: { color: "#94a3b8", bg: "#f8fafc", labelKey: "editor.dag_status_cancelled" },
  ERROR: { color: "#ef4444", bg: "#fef2f2", labelKey: "editor.dag_status_error" },
};

// ── 事件渲染辅助 ──

export function relativeTime(t: (key: string, opts?: Record<string, unknown>) => string, iso?: string | null): string {
  if (!iso) return "--";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 0) return t("runs.relative_now");
  if (diff < 60) return t("runs.relative_now");
  if (diff < 3600) return t("runs.relative_minutes", { count: Math.floor(diff / 60) });
  if (diff < 86400) return t("runs.relative_hours", { count: Math.floor(diff / 3600) });
  if (diff < 604800) return t("runs.relative_days", { count: Math.floor(diff / 86400) });
  return new Date(iso).toLocaleDateString();
}

export function formatEventType(t: (key: string) => string, type: string): string {
  const map: Record<string, string> = {
    "dag.started": t("editor.dag_started"),
    "dag.completed": t("editor.dag_completed"),
    "dag.cancelled": t("editor.dag_cancelled"),
    "node.started": t("editor.node_started"),
    "node.completed": t("editor.node_completed"),
    "node.failed": t("editor.node_failed"),
    "node.cancelled": t("editor.node_cancelled"),
    "node.retrying": t("editor.node_retrying"),
    "node.skipped": t("editor.node_skipped"),
    "sub_workflow.started": t("editor.sub_workflow_started"),
    "sub_workflow.completed": t("editor.sub_workflow_completed"),
    "loop.iteration_started": t("editor.loop_iteration_started"),
    "loop.iteration_completed": t("editor.loop_iteration_completed"),
    "audit.requested": t("editor.audit_requested"),
    "audit.approved": t("editor.audit_approved"),
  };
  return map[type] ?? type;
}

export function formatMeta(
  t: (key: string, opts?: Record<string, unknown>) => string,
  type: string,
  meta: Record<string, unknown>,
): string {
  if (type === "node.completed") {
    const parts: string[] = [];
    if (meta.exit_code != null) parts.push(`exit=${meta.exit_code}`);
    if (meta.output_size != null) parts.push(`${meta.output_size}B`);
    if (meta.latency_ms != null) parts.push(`${Math.round(Number(meta.latency_ms))}ms`);
    return parts.join(" · ");
  }
  if (type === "node.failed") return String(meta.error ?? "");
  if (type === "node.retrying") return t("editor.retry_meta", { attempt: meta.attempt, delay: meta.next_delay_ms });
  if (type === "node.started") {
    if (meta.pid) return `pid=${meta.pid}`;
    return "";
  }
  if (type === "dag.completed") {
    if (meta.duration_ms != null) return `${Math.round(Number(meta.duration_ms) / 1000)}s`;
    return "";
  }
  return "";
}
```

- [ ] **Step 2: 更新 WorkflowEditor.tsx 的 import**

删除 WorkflowEditor.tsx 底部的内联定义（`dedupEvents`、`DAG_STATUS_CFG`、`relativeTime`、`formatEventType`、`formatMeta`），改为从 utils.ts import：

```typescript
import { dedupEvents, DAG_STATUS_CFG } from "./utils";
```

（其他函数由子组件直接 import，WorkflowEditor 不需要直接引用）

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/utils.ts web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 迁移共享工具函数到 utils.ts"
```

---

### Task 2: 迁移独立组件到 components/ 目录

**Files:**
- Create: `web/src/pages/workflow/components/VersionPanel.tsx`
- Create: `web/src/pages/workflow/components/RunListPanel.tsx`
- Create: `web/src/pages/workflow/components/NodeOutputView.tsx`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`（删除原内联定义，改为 import）

**说明:** 这三个组件已在 WorkflowEditor 底部定义为独立函数组件，只需移动到新目录并更新 import。同时迁移 EventIcon 辅助组件。

- [ ] **Step 1: 创建 `web/src/pages/workflow/components/EventIcon.tsx`**

从 WorkflowEditor.tsx 行 2727-2747 提取：

```typescript
import {
  CheckCircle,
  Clock,
  Loader,
  Play,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";

export function EventIcon({ type }: { type: string }) {
  if (type.startsWith("dag.")) {
    const isOk = type === "dag.completed";
    return isOk ? (
      <CheckCircle size={11} style={{ color: "#22c55e", flexShrink: 0, marginTop: 1 }} />
    ) : type === "dag.cancelled" ? (
      <XCircle size={11} style={{ color: "#94a3b8", flexShrink: 0, marginTop: 1 }} />
    ) : (
      <Play size={11} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 1 }} />
    );
  }
  if (type.includes("failed")) return <XCircle size={11} style={{ color: "#ef4444", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("completed"))
    return <CheckCircle size={11} style={{ color: "#22c55e", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("started")) return <Loader size={11} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("retrying"))
    return <RefreshCw size={11} style={{ color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("audit"))
    return <ShieldCheck size={11} style={{ color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />;
  return <Clock size={11} style={{ color: "#94a3b8", flexShrink: 0, marginTop: 1 }} />;
}
```

- [ ] **Step 2: 创建 `web/src/pages/workflow/components/NodeOutputView.tsx`**

从 WorkflowEditor.tsx 行 2795-2880 提取。更新 import 路径：

```typescript
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import type { NodeOutput } from "../../../api/workflow-engine";

export function NodeOutputView({ output }: { output: NodeOutput }) {
  const { t } = useTranslation("workflows");
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(output.stdout).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      {/* 原行 2804-2878 的 JSX 完整复制，无需任何修改 */}
      {/* ... 包含 exit_code 显示、stdout pre 块、json output pre 块 ... */}
    </div>
  );
}
```

注意：完整 JSX 内容从原文件行 2804-2878 原样复制，只需更新 import。

- [ ] **Step 3: 创建 `web/src/pages/workflow/components/VersionPanel.tsx`**

从 WorkflowEditor.tsx 行 2204-2512 提取。更新 import 路径：

```typescript
// 顶部 import 替换为相对路径
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Inbox, Loader, Rocket, X } from "lucide-react";
import { workflowDefApi } from "../../../api/workflow-defs";
import { DAG_STATUS_CFG } from "../utils";
```

Props 类型保持不变：

```typescript
interface VersionPanelProps {
  workflowId?: string;
  onClose: () => void;
  onPublish: () => Promise<void>;
  publishing: boolean;
}

export function VersionPanel({ workflowId, onClose, onPublish, publishing }: VersionPanelProps) {
  // 行 2217-2512 的完整实现原样复制
}
```

- [ ] **Step 4: 创建 `web/src/pages/workflow/components/RunListPanel.tsx`**

从 WorkflowEditor.tsx 行 2516-2701 提取。更新 import 路径：

```typescript
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader, X } from "lucide-react";
import { type RunSummary, workflowEngineApi } from "../../../api/workflow-engine";
import { DAG_STATUS_CFG, relativeTime } from "../utils";
```

Props 类型保持不变。完整实现原样复制。

- [ ] **Step 5: 更新 WorkflowEditor.tsx 的 import**

删除 WorkflowEditor.tsx 底部的 VersionPanel、RunListPanel、NodeOutputView、EventIcon 函数定义，改为 import：

```typescript
import { VersionPanel } from "./components/VersionPanel";
import { RunListPanel } from "./components/RunListPanel";
import { NodeOutputView } from "./components/NodeOutputView";
```

- [ ] **Step 6: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 7: 提交**

```bash
git add web/src/pages/workflow/components/ web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 迁移 VersionPanel/RunListPanel/NodeOutputView/EventIcon 到 components/"
```

---

### Task 3: 提取 NodeConfigPanel

**Files:**
- Create: `web/src/pages/workflow/components/NodeConfigPanel.tsx`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`（替换行 1254-1777 为组件调用）

**说明:** 最大的组件（~525 行），包含节点属性编辑表单，按类型分支（shell/python/agent/api/audit/workflow/loop）+ 工作流元数据编辑。

- [ ] **Step 1: 创建 `web/src/pages/workflow/components/NodeConfigPanel.tsx`**

Props 接口：

```typescript
import { type Edge, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Lock, ShieldCheck } from "lucide-react";
import type { WfMeta } from "../yaml-utils";

interface NodeConfigPanelProps {
  selectedNode: Node | null;
  nodes: Node[];
  edges: Edge[];
  readOnly: boolean;
  updateNodeData: (data: Record<string, unknown>) => void;
  handleIdChange: (newId: string) => void;
  setNodes: ReturnType<typeof import("@xyflow/react").useNodesState<Node>>[1];
  setSelectedNode: (node: Node | null) => void;
  meta: WfMeta;
  updateMeta: (meta: Partial<WfMeta>) => void;
  agentList: Array<{ name: string; model: string | null; description: string | null }>;
  agentOverrideOpen: boolean;
  setAgentOverrideOpen: (open: boolean) => void;
}

export function NodeConfigPanel(props: NodeConfigPanelProps) {
  const {
    selectedNode,
    readOnly,
    updateNodeData,
    handleIdChange,
    setNodes,
    setSelectedNode,
    meta,
    updateMeta,
    agentList,
    agentOverrideOpen,
    setAgentOverrideOpen,
  } = props;

  const { t } = useTranslation("workflows");
  const sd = selectedNode?.data as Record<string, unknown> | undefined;
  const nodeType = selectedNode?.type ?? "shell";
  const isStartNode = selectedNode?.id === "__start__";

  return (
    <div className="wf-prop-body">
      {/* 行 1257-1775 的完整 JSX 原样迁移 */}
      {/* 包含: readonly 提示、start 节点、节点基本信息、按类型配置、高级配置、工作流元数据 */}
    </div>
  );
}
```

内容说明：从 WorkflowEditor.tsx 行 1256-1776 的 JSX 原样迁移。注意以下细节：
- `sd`、`nodeType`、`isStartNode` 在组件内部重新计算
- `START_NODE_ID` 需要导入：`import { START_NODE_ID } from "../yaml-utils";`
- `isStartNode` 判断改为 `selectedNode?.id === START_NODE_ID`

- [ ] **Step 2: 修改 WorkflowEditor.tsx，替换配置 Tab 内容**

删除行 1254-1777（配置 Tab 的完整 JSX），替换为：

```typescript
        {rightTab === "config" && (
          <NodeConfigPanel
            selectedNode={selectedNode}
            nodes={nodes}
            edges={edges}
            readOnly={readOnly}
            updateNodeData={updateNodeData}
            handleIdChange={handleIdChange}
            setNodes={setNodes}
            setSelectedNode={setSelectedNode}
            meta={meta}
            updateMeta={updateMeta}
            agentList={agentList}
            agentOverrideOpen={agentOverrideOpen}
            setAgentOverrideOpen={setAgentOverrideOpen}
          />
        )}
```

添加 import：`import { NodeConfigPanel } from "./components/NodeConfigPanel";`

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/components/NodeConfigPanel.tsx web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 提取 NodeConfigPanel 组件"
```

---

### Task 4: 提取 RunStatusPanel

**Files:**
- Create: `web/src/pages/workflow/components/RunStatusPanel.tsx`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`（替换行 1779-2127 为组件调用）

**说明:** 运行状态面板（~350 行），包含运行状态头、审批卡片、进度条、事件/输出子 Tab、事件列表、节点输出查看、历史运行列表。

- [ ] **Step 1: 创建 `web/src/pages/workflow/components/RunStatusPanel.tsx`**

Props 接口：

```typescript
import { type Edge, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import {
  Edit3,
  Loader,
  RefreshCw,
  ShieldCheck,
  Square,
} from "lucide-react";
import {
  type DAGEvent,
  type DAGSnapshot,
  type NodeOutput,
  type PendingApproval,
} from "../../../api/workflow-engine";
import { DAG_STATUS_CFG, dedupEvents, formatEventType, formatMeta } from "../utils";
import { EventIcon } from "./EventIcon";
import { NodeOutputView } from "./NodeOutputView";
import { RunListPanel } from "./RunListPanel";

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
  handleBackToEdit: () => void;
  isRunMode: boolean;
  isRunDone: boolean;
  workflowId: string | undefined;
  // RunListPanel onSelect 需要的回调
  onSelectRun: (runId: string) => Promise<void>;
  onCloseRunList: () => void;
}

export function RunStatusPanel(props: RunStatusPanelProps) {
  const { t } = useTranslation("workflows");

  // 行 1781-2127 的完整 JSX 迁移
  // 包含：
  // - 运行状态头（状态徽章 + 操作按钮）
  // - 审批卡片
  // - 进度条
  // - 事件/输出子 tab
  // - 事件列表
  // - 节点输出查看（使用 NodeOutputView）
  // - 历史运行列表（使用 RunListPanel）
}
```

迁移要点：
- 原 RunListPanel 的 `onSelect` 回调使用 `setActiveRunId`、`setRunSnapshot` 等 setter — 这些通过 `onSelectRun` 回调传到 WorkflowEditor 层面处理
- 原 `onClose` 回调通过 `onCloseRunList` prop 传递
- `EventIcon`、`formatEventType`、`formatMeta` 从各自的模块 import

- [ ] **Step 2: 修改 WorkflowEditor.tsx，替换运行 Tab 内容**

删除行 1779-2127（运行 Tab 的完整 JSX），替换为：

```typescript
        {rightTab === "run" && (
          <RunStatusPanel
            activeRunId={activeRunId}
            runSnapshot={runSnapshot}
            runEvents={runEvents}
            runApprovals={runApprovals}
            running={running}
            dagStatus={dagStatus}
            selectedRunNodeId={selectedRunNodeId}
            selectedNodeOutput={selectedNodeOutput}
            nodeOutputLoading={nodeOutputLoading}
            runRightTab={runRightTab}
            setRunRightTab={setRunRightTab}
            handleCancelRun={handleCancelRun}
            handleApprove={handleApprove}
            handleRerunFrom={handleRerunFrom}
            setSelectedRunNodeId={setSelectedRunNodeId}
            handleBackToEdit={handleBackToEdit}
            isRunMode={isRunMode}
            isRunDone={isRunDone}
            workflowId={workflowId}
            onSelectRun={async (runId) => {
              setActiveRunId(runId);
              setRunSnapshot(null);
              setRunEvents([]);
              setRunApprovals([]);
              setSelectedRunNodeId(null);
              setSelectedNodeOutput(null);
              try {
                const [snap, evts] = await Promise.all([
                  workflowEngineApi.getRunStatus(runId),
                  workflowEngineApi.getEvents(runId),
                ]);
                if (snap) {
                  setRunSnapshot(snap);
                  updateNodesFromSnapshot(snap);
                }
                if (Array.isArray(evts)) setRunEvents(dedupEvents(evts));
              } catch (err) {
                console.error(`${t("editor.load_run_data_failed")}:`, err);
              }
            }}
            onCloseRunList={() => setRightTab("config")}
          />
        )}
```

添加 import：`import { RunStatusPanel } from "./components/RunStatusPanel";`

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/components/RunStatusPanel.tsx web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 提取 RunStatusPanel 组件"
```

---

### Task 5: 提取 WorkflowToolbar

**Files:**
- Create: `web/src/pages/workflow/components/WorkflowToolbar.tsx`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`（替换行 962-1091 为组件调用）

**说明:** ReactFlow 顶部工具栏面板（~130 行），包含所有工具按钮。

- [ ] **Step 1: 创建 `web/src/pages/workflow/components/WorkflowToolbar.tsx`**

```typescript
import { useTranslation } from "react-i18next";
import {
  CheckCircle,
  Code,
  Download,
  Edit3,
  Eye,
  FilePlus,
  LayoutGrid,
  List,
  MessageSquare,
  Play,
  RefreshCw,
  Rocket,
  Save,
  Upload,
} from "lucide-react";
import { PALETTE_ITEMS } from "../constants";

interface WorkflowToolbarProps {
  readOnly: boolean;
  workflowId: string | undefined;
  isRunMode: boolean;
  isRunDone: boolean;
  running: boolean;
  saveStatus: "idle" | "saving" | "saved";
  yamlOpen: boolean;
  chatOpen: boolean;
  rightTab: "config" | "run" | "versions";
  handleNew: () => void;
  handleFileImportClick: () => void;
  handleExportYaml: () => void;
  handleAutoLayout: () => void;
  handleRefreshDraft: () => Promise<void>;
  handleSaveDraft: () => Promise<void>;
  handleDryRun: () => Promise<void>;
  handleRun: () => Promise<void>;
  setReadOnly: (readOnly: boolean) => void;
  setYamlOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setChatOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setRightTab: (tab: "config" | "run" | "versions") => void;
  syncYaml: () => string;
}

export function WorkflowToolbar(props: WorkflowToolbarProps) {
  const { t } = useTranslation("workflows");

  // 行 963-1091 的完整 JSX 迁移
  // 包含所有工具栏按钮
}
```

注意：`PALETTE_ITEMS` 目前定义在 WorkflowEditor.tsx 顶部。需要抽取为共享常量（见下方 Task 5 Step 1a）。

- [ ] **Step 1a: 创建 `web/src/pages/workflow/constants.ts` — 提取 PALETTE_ITEMS**

从 WorkflowEditor.tsx 行 80-88 提取：

```typescript
import { Bot, Code, Globe, ShieldCheck, Terminal } from "lucide-react";

export const PALETTE_ITEMS = [
  { type: "shell", labelKey: "nodes.shell", icon: Terminal, color: "#3b82f6" },
  { type: "python", labelKey: "nodes.python", icon: Code, color: "#0ea5e9" },
  { type: "agent", labelKey: "nodes.agent", icon: Bot, color: "#22c55e" },
  { type: "api", labelKey: "nodes.api", icon: Globe, color: "#8b5cf6" },
  { type: "audit", labelKey: "editor.palette_audit", icon: ShieldCheck, color: "#f59e0b" },
] as const;
```

WorkflowEditor.tsx 改为 `import { PALETTE_ITEMS } from "./constants";`

- [ ] **Step 2: 修改 WorkflowEditor.tsx，替换工具栏面板**

删除行 962-1091（Panel position="top-center" 整个块），替换为：

```typescript
          <Panel position="top-center" className="wf-panel-toolbar">
            <WorkflowToolbar
              readOnly={readOnly}
              workflowId={workflowId}
              isRunMode={isRunMode}
              isRunDone={isRunDone}
              running={running}
              saveStatus={saveStatus}
              yamlOpen={yamlOpen}
              chatOpen={chatOpen}
              rightTab={rightTab}
              handleNew={handleNew}
              handleFileImportClick={() => fileInputRef.current?.click()}
              handleExportYaml={handleExportYaml}
              handleAutoLayout={handleAutoLayout}
              handleRefreshDraft={handleRefreshDraft}
              handleSaveDraft={handleSaveDraft}
              handleDryRun={handleDryRun}
              handleRun={handleRun}
              setReadOnly={setReadOnly}
              setYamlOpen={setYamlOpen}
              setChatOpen={setChatOpen}
              setRightTab={setRightTab}
              syncYaml={syncYaml}
            />
          </Panel>
```

添加 import：`import { WorkflowToolbar } from "./components/WorkflowToolbar";`

注意：WorkflowToolbar 内部也包含 `readOnly` 切换按钮。原来 `setReadOnly` 是直接调用 `setReadOnly(!readOnly)`，需要从 WorkflowEditor 传入 `setReadOnly` setter。

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/constants.ts web/src/pages/workflow/components/WorkflowToolbar.tsx web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 提取 WorkflowToolbar + PALETTE_ITEMS 常量"
```

---

### Task 6: 提取 MetaAgentPanel

**Files:**
- Create: `web/src/pages/workflow/components/MetaAgentPanel.tsx`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`（替换行 2140-2189 为组件调用）

**说明:** Meta Agent 聊天侧边栏（~50 行），最简单的组件。

- [ ] **Step 1: 创建 `web/src/pages/workflow/components/MetaAgentPanel.tsx`**

```typescript
import { useTranslation } from "react-i18next";
import { Bot, ChevronRight } from "lucide-react";
import { ChatPanel } from "../../agent-panel/ChatPanel";

interface MetaAgentPanelProps {
  chatOpen: boolean;
  setChatOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  metaAgentId: string | null;
  scenePrompt: string | undefined;
}

export function MetaAgentPanel({ chatOpen, setChatOpen, metaAgentId, scenePrompt }: MetaAgentPanelProps) {
  const { t } = useTranslation("workflows");

  if (!chatOpen) return null;

  return (
    <div
      style={{
        width: 400,
        minWidth: 400,
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        borderLeft: "1px solid #e5e7eb",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          <Bot size={14} />
          Meta Agent
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button
            type="button"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 4,
              borderRadius: 4,
              color: "#6b7280",
              display: "flex",
              alignItems: "center",
            }}
            onClick={() => setChatOpen(false)}
            title={t("editor.chat_collapse")}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <ChatPanel agentId={metaAgentId} hideSidebar scenePrompt={scenePrompt} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 修改 WorkflowEditor.tsx，替换 Meta Agent 侧边栏**

删除行 2140-2189（Meta Agent Chat 侧边栏），替换为：

```typescript
      <MetaAgentPanel
        chatOpen={chatOpen}
        setChatOpen={setChatOpen}
        metaAgentId={metaAgentId}
        scenePrompt={scenePrompt}
      />
```

添加 import：`import { MetaAgentPanel } from "./components/MetaAgentPanel";`

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/components/MetaAgentPanel.tsx web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 提取 MetaAgentPanel 组件"
```

---

### Task 7: 提取 YamlSlidePanel

**Files:**
- Create: `web/src/pages/workflow/components/YamlSlidePanel.tsx`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`（替换行 1193-1221 为组件调用）

**说明:** YAML 编辑器滑出面板（~30 行），第二个最简单的组件。注意也包含保存状态指示器和 DryRun 结果提示（行 1094-1191），这些留在 WorkflowEditor 还是移入 YamlSlidePanel 需要判断。

设计决策：保存状态指示器和 DryRun 结果提示是覆盖在画布上方的浮层，不属于 YAML 滑出面板，保留在 WorkflowEditor 中。

- [ ] **Step 1: 创建 `web/src/pages/workflow/components/YamlSlidePanel.tsx`**

```typescript
import { useTranslation } from "react-i18next";
import { Upload, X } from "lucide-react";

interface YamlSlidePanelProps {
  yamlOpen: boolean;
  yamlText: string;
  setYamlText: (text: string) => void;
  readOnly: boolean;
  onImport: () => void;
  onClose: () => void;
}

export function YamlSlidePanel({ yamlOpen, yamlText, setYamlText, readOnly, onImport, onClose }: YamlSlidePanelProps) {
  const { t } = useTranslation("workflows");

  return (
    <div className={`wf-yaml-slide ${yamlOpen ? "open" : ""}`}>
      <div className="wf-yaml-slide-header">
        <span className="wf-yaml-slide-title">{t("editor.yaml_title")}</span>
        <div style={{ display: "flex", gap: 4 }}>
          {!readOnly && (
            <button
              type="button"
              className="wf-toolbar-btn"
              onClick={onImport}
              data-tooltip={t("editor.yaml_tooltip_apply")}
            >
              <Upload size={14} />
            </button>
          )}
          <button type="button" className="wf-toolbar-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      <textarea
        className="wf-yaml-textarea"
        value={yamlText}
        onChange={(e) => setYamlText(e.target.value)}
        spellCheck={false}
        placeholder={t("editor.yaml_placeholder")}
        readOnly={readOnly}
      />
    </div>
  );
}
```

- [ ] **Step 2: 修改 WorkflowEditor.tsx，替换 YAML 滑出面板**

删除行 1193-1221（YAML 滑出面板），替换为：

```typescript
        <YamlSlidePanel
          yamlOpen={yamlOpen}
          yamlText={yamlText}
          setYamlText={setYamlText}
          readOnly={readOnly}
          onImport={handleImportYaml}
          onClose={() => setYamlOpen(false)}
        />
```

添加 import：`import { YamlSlidePanel } from "./components/YamlSlidePanel";`

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/components/YamlSlidePanel.tsx web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor: 提取 YamlSlidePanel 组件"
```

---

### Task 8: Full precheck 验证

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
git commit -m "refactor: WorkflowEditor Phase 2 JSX 子组件拆分完成"
```

---

## 重构后 WorkflowEditorInner 结构预估

```
WorkflowEditorInner (~200-300 行)
  ├─ useState 声明 (~30 行)
  ├─ 4 个 hook 调用 (~50 行)
  ├─ 派生状态和少量内联逻辑 (~10 行)
  ├─ 数据加载 useEffect (~60 行)
  ├─ handleRefreshDraft, updateMeta, handleImportYaml wrapper (~40 行)
  └─ JSX 渲染 (~100-150 行，纯组合子组件)
      ├─ <input type="file" hidden />
      ├─ <ReactFlow> + 节点面板
      ├─ <WorkflowToolbar />
      ├─ 保存状态指示器 / DryRun 结果提示（浮层，保留内联）
      ├─ <YamlSlidePanel />
      ├─ <aside> 右侧面板
      │   ├─ Tab 头（config / run / versions）
      │   ├─ <NodeConfigPanel />
      │   ├─ <RunStatusPanel />
      │   └─ <VersionPanel />
      └─ <MetaAgentPanel />
```

## 重构后文件结构

```
web/src/pages/workflow/
  ├─ WorkflowEditor.tsx          (~200-300 行，主组件)
  ├─ constants.ts                (PALETTE_ITEMS)
  ├─ utils.ts                    (dedupEvents, DAG_STATUS_CFG, relativeTime, formatEventType, formatMeta)
  ├─ layout.ts                   (autoLayout，不变)
  ├─ nodes/                      (节点类型，不变)
  ├─ yaml-utils.ts               (YAML 工具，不变)
  ├─ workflow.css                 (样式，不变)
  ├─ hooks/
  │   ├─ useWorkflowCanvas.ts    (画布交互)
  │   ├─ useWorkflowPersistence.ts (保存/发布)
  │   ├─ useWorkflowRun.ts       (运行模式)
  │   └─ useWorkflowMetaAgent.ts (Meta Agent)
  └─ components/
      ├─ EventIcon.tsx           (事件图标)
      ├─ NodeOutputView.tsx      (节点输出)
      ├─ NodeConfigPanel.tsx     (节点配置面板)
      ├─ RunStatusPanel.tsx      (运行状态面板)
      ├─ RunListPanel.tsx        (历史运行列表)
      ├─ VersionPanel.tsx        (版本管理面板)
      ├─ WorkflowToolbar.tsx     (工具栏)
      ├─ YamlSlidePanel.tsx      (YAML 编辑面板)
      └─ MetaAgentPanel.tsx      (Meta Agent 面板)
```
