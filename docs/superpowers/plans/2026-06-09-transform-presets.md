# Transform 预设模板实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 workflow 编辑器面板新增 5 种 transform 预设节点（提取/过滤/聚合/合并/排序），拖出即带预填 `output` 表达式，连线上游自动补 `inputs` + `depends_on`，修改 output key 名时表达式自动同步。

**Architecture:** 纯前端功能。定义 `TRANSFORM_PRESETS` 配置对象，面板显示 5 个预设条目，拖出时注入 `defaultOutput`。连线在 `useWorkflowCanvas` 的 `onConnect` 中检测后自动补全。key 改名在 `NodeConfigCard/NodeConfigPanel` 的 `InputsEditor.onChange` 回调中触发表达式同步。YAML 不包含 preset 字段。

**Tech Stack:** React 19, @xyflow/react, i18next

---

### Task 1: 预设配置定义

**Files:**
- Create: `web/src/pages/workflow/presets.ts`

- [ ] **Step 1: 创建预设配置文件**

```typescript
/**
 * Transform 节点预设模板配置
 *
 * 五种预设底层都是 type: "transform"，区别在 output 默认值和 inputs 分配规则。
 * preset 字段仅前端运行时使用，不写入 YAML。
 */

import { ArrowUpDown, BarChart3, Combine, Filter, ListFilter } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface TransformPreset {
  id: string;
  labelKey: string;
  icon: LucideIcon;
  color: string;
  /** 拖出节点时的默认 output */
  defaultOutput: Record<string, string>;
  /** 需要上游连接的最小数量（用于自动补 inputs 时分配变量名） */
  minUpstream: number;
}

export const TRANSFORM_PRESETS: TransformPreset[] = [
  {
    id: "extract",
    labelKey: "nodes.preset_extract",
    icon: ListFilter,
    color: "#f97316",
    defaultOutput: {
      field1: "data.items.map(i => i.field1)",
      field2: "data.items.map(i => i.field2)",
    },
    minUpstream: 1,
  },
  {
    id: "filter",
    labelKey: "nodes.preset_filter",
    icon: Filter,
    color: "#f97316",
    defaultOutput: {
      filtered: "data.items.filter(i => i.field1 >= value1)",
    },
    minUpstream: 1,
  },
  {
    id: "aggregate",
    labelKey: "nodes.preset_aggregate",
    icon: BarChart3,
    color: "#f97316",
    defaultOutput: {
      total: "data.items.length",
      avg: "data.items.reduce((s, i) => s + i.field1, 0) / data.items.length",
      sum: "data.items.reduce((s, i) => s + i.field1, 0)",
    },
    minUpstream: 1,
  },
  {
    id: "merge",
    labelKey: "nodes.preset_merge",
    icon: Combine,
    color: "#f97316",
    defaultOutput: {
      combined: "Object.assign({}, src1, src2)",
    },
    minUpstream: 2,
  },
  {
    id: "sort",
    labelKey: "nodes.preset_sort",
    icon: ArrowUpDown,
    color: "#f97316",
    defaultOutput: {
      sorted: "data.items.sort((a, b) => b.field1 - a.field1)",
    },
    minUpstream: 1,
  },
];

/** 通过 preset id 查找预设配置 */
export function getPresetById(id: string): TransformPreset | undefined {
  return TRANSFORM_PRESETS.find((p) => p.id === id);
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/presets.ts
git commit -m "feat(web): add transform preset configuration definitions"
```

---

### Task 2: 编辑器面板 — WorkflowEditor.tsx

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

- [ ] **Step 1: 替换单一的 transform palette 为 5 个预设**

找到 `PALETTE_ITEMS` 数组，将原来的单一 transform 条目替换为按预设遍历生成：

```typescript
import { TRANSFORM_PRESETS } from "./presets";

const PALETTE_ITEMS = [
  { type: "shell",   labelKey: "nodes.shell",   icon: Terminal,    color: "#3b82f6" },
  { type: "python",  labelKey: "nodes.python",  icon: Code,        color: "#0ea5e9" },
  { type: "agent",   labelKey: "nodes.agent",   icon: Bot,         color: "#22c55e" },
  { type: "api",     labelKey: "nodes.api",     icon: Globe,       color: "#8b5cf6" },
  { type: "audit",   labelKey: "editor.palette_audit", icon: ShieldCheck, color: "#f59e0b" },
  // 数据变换分组
  ...TRANSFORM_PRESETS.map((p) => ({
    type: "transform" as const,
    preset: p.id,
    labelKey: p.labelKey,
    icon: p.icon,
    color: p.color,
  })),
] as const;
```

- [ ] **Step 2: 面板渲染区分分组**

在渲染面板的面板 JSX 中，在基础节点和 transform 预设之间加一个分隔符或小标题（可选，用分隔线即可）：

```tsx
{/* 基础节点 */}
{PALETTE_ITEMS.slice(0, 5).map(item => (
  // ... existing palette item rendering
))}
{/* 分隔 */}
<div className="wf-palette-divider" />
{/* 数据变换 */}
{PALETTE_ITEMS.slice(5).map(item => (
  // ... same rendering
))}
```

样式（在 `workflow.css` 中加）：
```css
.wf-palette-divider {
  border-top: 1px solid var(--border);
  margin: 6px 0;
  width: 100%;
}
```

- [ ] **Step 3: 拖拽 dataTransfer 加 preset 信息**

在面板项的 `onDragStart` 中，如果 item 有 `preset` 字段，一并写入 dataTransfer：

```typescript
onDragStart={(event) => {
  event.dataTransfer.setData("application/workflow-node", item.type);
  if ("preset" in item && item.preset) {
    event.dataTransfer.setData("application/workflow-preset", item.preset);
  }
  event.dataTransfer.effectAllowed = "move";
}}
```

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx web/src/pages/workflow/workflow.css
git commit -m "feat(web): replace single transform with 5 preset items in palette"
```

---

### Task 3: 画布 Hook — useWorkflowCanvas.ts

**Files:**
- Modify: `web/src/pages/workflow/hooks/useWorkflowCanvas.ts`

- [ ] **Step 1: addNode 支持 preset 参数**

修改 `addNode` 函数签名，增加 `preset` 可选参数。当有 preset 时，创建节点附加 `defaultOutput`：

```typescript
import { getPresetById } from "../presets";

function addNode(type: string, preset?: string) {
  const id = nextNodeId(type);
  const presetConfig = preset ? getPresetById(preset) : undefined;

  const newNode = {
    id,
    type,
    position: getRandomPosition(),
    data: {
      label: id,
      type,
      ...(presetConfig ? {
        output: { ...presetConfig.defaultOutput },
        _preset: preset,  // 前端运行时标记，不写入 YAML
      } : {}),
    },
  };

  setNodes((nds) => [...nds, newNode]);
}
```

- [ ] **Step 2: 画布 onDrop 读取 preset**

在画布的 `onDrop` 回调中：

```typescript
const type = event.dataTransfer.getData("application/workflow-node");
const preset = event.dataTransfer.getData("application/workflow-preset");
if (type) {
  addNode(type, preset || undefined);
}
```

- [ ] **Step 3: onConnect 自动补 inputs**

在 `onConnect` 回调中（连接建立后），检测目标节点是否为 transform 且有 preset：

```typescript
onConnect: useCallback((connection: Connection) => {
  setEdges((eds) => addEdge(connection, eds));

  // 自动补全：检测目标为 transform 节点且有预设
  setNodes((nds) => nds.map((n) => {
    if (n.id !== connection.target) return n;
    if (n.data?.type !== "transform") return n;
    
    const presetId = n.data?._preset as string | undefined;
    if (!presetId) return n;
    
    const preset = getPresetById(presetId);
    if (!preset) return n;

    // 收集所有连接到该节点的上游节点 ID
    const upstreamIds = eds
      .filter((e) => e.target === n.id)
      .map((e) => e.source);

    if (upstreamIds.length < preset.minUpstream) return n;

    // 按预设类型分配 inputs 变量名
    const inputs: Record<string, string> = {};
    if (preset.id === "merge") {
      upstreamIds.slice(0, 2).forEach((uid, i) => {
        inputs[`src${i + 1}`] = `nodes.${uid}.output`;
      });
    } else {
      inputs["data"] = `nodes.${upstreamIds[0]}.output`;
    }

    return {
      ...n,
      data: {
        ...n.data,
        inputs,
        depends_on: [...new Set([...(n.data?.depends_on || []), ...upstreamIds])],
      },
    };
  }));
}, [setEdges, setNodes]),
```

注意：此处可能有闭包问题（eds 是 stale 值）。需要从 `useReactFlow` 获取最新 edges，或使用 `setEdges` + `setNodes` 的函数形式。

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/workflow/hooks/useWorkflowCanvas.ts
git commit -m "feat(web): add preset-aware node creation and auto-inputs on connect"
```

---

### Task 4: Output key 改名自动同步表达式

**Files:**
- Create: `web/src/pages/workflow/preset-utils.ts`
- Modify: `web/src/pages/workflow/components/NodeConfigCard.tsx`
- Modify: `web/src/pages/workflow/components/NodeConfigPanel.tsx`

- [ ] **Step 1: 创建 key 改名同步工具函数**

```typescript
/**
 * 当用户修改 output 的 key 名时，同步更新表达式中的同名引用。
 *
 * 规则：
 * - 仅当旧 key 名作为独立标识符出现在表达式中时才替换
 * - 例如 key 从 field1 改 name → "data.items.map(i => i.field1)" 变为 "data.items.map(i => i.name)"
 * - 但同时也会误改 "other.field1.x" 中的 field1。这是个已知限制，MVP 阶段接受。
 *
 * @param output 当前的 output 映射
 * @param oldKey 旧 key 名
 * @param newKey 新 key 名
 * @returns 更新后的 output 映射
 */
export function syncExpressionOnKeyRename(
  output: Record<string, string>,
  oldKey: string,
  newKey: string,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, expr] of Object.entries(output)) {
    const newExprKey = key === oldKey ? newKey : key;
    // 替换表达式中所有旧 key 名出现的位置（包括 .field1, field1 >=, [field1] 等场景）
    const newExpr = expr.replace(new RegExp(`\\b${escapeRegex(oldKey)}\\b`, "g"), newKey);
    result[newExprKey] = newExpr;
  }

  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 2: NodeConfigCard 的 InputsEditor.onChange 中调用同步**

在 transform output 的 `InputsEditor` 的 `onChange` 回调中，检测 key 名变更并触发同步：

```typescript
// 在 NodeConfigCard.tsx 的 transform output 配置区
onChange={(val) => {
  const cleaned: Record<string, string> = {};
  if (val) {
    for (const [k, v] of Object.entries(val)) {
      if (k.trim()) cleaned[k.trim()] = v;
    }
  }
  
  // 检测 key 名变更并同步表达式
  const oldOutput = (sd?.output as Record<string, string>) ?? {};
  const synced = syncOutputOnRename(oldOutput, cleaned);
  
  updateNodeData({ output: Object.keys(synced).length ? synced : undefined });
}}
```

其中 `syncOutputOnRename` 是包装函数：

```typescript
import { syncExpressionOnKeyRename } from "../../preset-utils";

function syncOutputOnRename(
  oldOutput: Record<string, string>,
  newOutput: Record<string, string>,
): Record<string, string> {
  const oldKeys = Object.keys(oldOutput);
  const newKeys = Object.keys(newOutput);
  
  // 找到被改名的 key：旧 key 不在新 keys 中，且新 key 不在旧 keys 中
  const removedKeys = oldKeys.filter(k => !(k in newOutput));
  const addedKeys = newKeys.filter(k => !(k in oldOutput));
  
  // 简单策略：假设 removed 和 added 一一对应（顺序映射）
  let result = { ...newOutput };
  const renameCount = Math.min(removedKeys.length, addedKeys.length);
  for (let i = 0; i < renameCount; i++) {
    result = syncExpressionOnKeyRename(result, removedKeys[i], addedKeys[i]);
  }
  
  return result;
}
```

- [ ] **Step 3: NodeConfigPanel 同样加同步逻辑**

同 Step 2。

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/workflow/preset-utils.ts web/src/pages/workflow/components/NodeConfigCard.tsx web/src/pages/workflow/components/NodeConfigPanel.tsx
git commit -m "feat(web): auto-sync expression on output key rename"
```

---

### Task 5: YAML 工具 — yaml-utils.ts

**Files:**
- Modify: `web/src/pages/workflow/yaml-utils.ts`

- [ ] **Step 1: flowToYaml 过滤 _preset 字段**

在 `flowToYaml()` 中生成节点数据时，排除 `_preset` 字段（不写入 YAML）：

```typescript
// 在生成 node entry 时
const { _preset, ...nodeData } = n.data;
// 后续只用 nodeData
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/yaml-utils.ts
git commit -m "feat(web): filter _preset field from YAML output"
```

---

### Task 6: i18n 翻译

**Files:**
- Modify: `web/src/i18n/locales/en/workflows.json`
- Modify: `web/src/i18n/locales/zh/workflows.json`

- [ ] **Step 1: 英文**

在 `nodes` 对象中加入：

```json
    "preset_extract": "Extract",
    "preset_filter": "Filter",
    "preset_aggregate": "Aggregate",
    "preset_merge": "Merge",
    "preset_sort": "Sort",
```

- [ ] **Step 2: 中文**

```json
    "preset_extract": "提取",
    "preset_filter": "过滤",
    "preset_aggregate": "聚合",
    "preset_merge": "合并",
    "preset_sort": "排序",
```

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/locales/en/workflows.json web/src/i18n/locales/zh/workflows.json
git commit -m "feat(i18n): add transform preset translations"
```

---

### Task 7: 构建 & 验证

- [ ] **Step 1: 前端构建**

```bash
bun run build:web
```

期望：构建成功，无 TS 错误。

- [ ] **Step 2: precheck**

```bash
bun run precheck
```

期望：通过。

- [ ] **Step 3: 手动验证**

```bash
bun run dev &
bun run dev:web &
```

验证项：
1. 面板显示两组：基础节点 + 数据变换（分隔线）
2. 5 个预设节点可拖出，output 预填正确
3. 连线到上游后 inputs + depends_on 自动补
4. 修改 output key 名时表达式自动同步
5. 保存后 YAML 中不出现 `_preset` 字段

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: final verification of transform presets"
```
