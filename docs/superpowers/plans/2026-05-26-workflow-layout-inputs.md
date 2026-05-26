# Workflow 画布竖直布局 + Inputs 编辑器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 workflow 画布节点布局从水平（左到右）改为竖直（上到下），并为 shell/python 节点新增 inputs 键值对编辑器。

**Architecture:** 两处独立改动。画布方向通过修改 dagre `rankdir` 和 ReactFlow Handle `position` 实现。Inputs 编辑器作为内联组件 `InputsEditor` 嵌入 `NodeConfigPanel`，通过 `updateNodeData` 更新节点数据，`flowToYaml` 已自动序列化 `node.data` 中的所有非 `_` 前缀字段，无需额外改动。

**Tech Stack:** TypeScript, React 19, @xyflow/react, dagre, react-i18next

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `web/src/pages/workflow/layout.ts` | dagre 自动布局方向 LR → TB |
| Modify | `web/src/pages/workflow/nodes.tsx` | 节点 Handle 位置 Left/Right → Top/Bottom |
| Modify | `web/src/pages/workflow/yaml-utils.ts:80` | 新节点默认坐标改为纵向排布 |
| Modify | `web/src/pages/workflow/components/NodeConfigPanel.tsx` | 新增 InputsEditor 内联组件 + shell/python 的 inputs 编辑区 |
| Modify | `web/src/i18n/locales/en/workflows.json` | 英文 i18n key |
| Modify | `web/src/i18n/locales/zh/workflows.json` | 中文 i18n key |

---

### Task 1: 画布布局方向 LR → TB

**Files:**
- Modify: `web/src/pages/workflow/layout.ts` (全文 31 行)
- Modify: `web/src/pages/workflow/nodes.tsx:157` (target Handle)
- Modify: `web/src/pages/workflow/nodes.tsx:286` (source Handle)
- Modify: `web/src/pages/workflow/yaml-utils.ts:80` (默认坐标)

- [ ] **Step 1: 修改 dagre 布局方向**

在 `web/src/pages/workflow/layout.ts` 中，将 `rankdir` 从 `"LR"` 改为 `"TB"`，将 `ranksep` 从 `100` 改为 `80`：

```typescript
// layout.ts 全文替换
import type { Edge, Node } from "@xyflow/react";
import dagre from "dagre";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;

export function autoLayout(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    };
  });
}
```

- [ ] **Step 2: 修改节点 Handle 位置**

在 `web/src/pages/workflow/nodes.tsx` 中：

第 157 行，target Handle 从 `Position.Left` 改为 `Position.Top`：
```tsx
{!isStart && (
  <Handle
    type="target"
    position={Position.Top}
    style={{ background: colors.main, width: 8, height: 8, border: "2px solid #fff" }}
  />
)}
```

第 286 行，source Handle 从 `Position.Right` 改为 `Position.Bottom`：
```tsx
<Handle
  type="source"
  position={Position.Bottom}
  style={{ background: colors.main, width: 8, height: 8, border: "2px solid #fff" }}
/>
```

- [ ] **Step 3: 修改 yamlToFlow 新节点默认坐标**

在 `web/src/pages/workflow/yaml-utils.ts` 第 80 行，将水平排布坐标改为纵向排布：

```typescript
position: { x: 100 + (idx % 3) * 200, y: 80 + idx * 100 },
```

- [ ] **Step 4: 提交画布布局改动**

```bash
git add web/src/pages/workflow/layout.ts web/src/pages/workflow/nodes.tsx web/src/pages/workflow/yaml-utils.ts
git commit -m "feat: workflow 画布节点布局从水平改为竖直(TB)"
```

---

### Task 2: 新增 i18n key

**Files:**
- Modify: `web/src/i18n/locales/en/workflows.json`
- Modify: `web/src/i18n/locales/zh/workflows.json`

- [ ] **Step 1: 在英文 i18n 文件的 `editor` 对象末尾（第 285 行 `type_api` 之后）添加 inputs 相关 key**

```json
    "type_api": "API",
    "inputs_title": "Inputs",
    "inputs_key_placeholder": "Variable name",
    "inputs_value_placeholder": "Expression",
    "inputs_add": "Add Input"
```

- [ ] **Step 2: 在中文 i18n 文件的 `editor` 对象末尾（第 285 行 `type_api` 之后）添加 inputs 相关 key**

```json
    "type_api": "API",
    "inputs_title": "Inputs",
    "inputs_key_placeholder": "变量名",
    "inputs_value_placeholder": "表达式",
    "inputs_add": "添加 Input"
```

- [ ] **Step 3: 提交 i18n 改动**

```bash
git add web/src/i18n/locales/en/workflows.json web/src/i18n/locales/zh/workflows.json
git commit -m "feat: workflow inputs 编辑器 i18n key"
```

---

### Task 3: 新增 InputsEditor 内联组件并集成到 NodeConfigPanel

**Files:**
- Modify: `web/src/pages/workflow/components/NodeConfigPanel.tsx`

- [ ] **Step 1: 在 NodeConfigPanel.tsx 顶部导入区新增 `Plus` 和 `Trash2` 图标**

在第 2 行已有的 lucide-react import 中添加 `Plus` 和 `Trash2`：

```typescript
import { ChevronRight, Lock, Plus, Trash2 } from "lucide-react";
```

- [ ] **Step 2: 在 `NodeConfigPanel` 函数组件之前（第 23 行之前），定义 `InputsEditor` 内联组件**

```tsx
function InputsEditor({
  value,
  onChange,
  readOnly,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  value: Record<string, string> | undefined;
  onChange: (val: Record<string, string> | undefined) => void;
  readOnly: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  const entries = Object.entries(value ?? {});

  const updateEntry = (index: number, field: "key" | "value", newValue: string) => {
    const updated = { ...value };
    const oldKey = entries[index][0];
    if (field === "key") {
      delete updated[oldKey];
      updated[newValue] = entries[index][1];
    } else {
      updated[oldKey] = newValue;
    }
    onChange(updated);
  };

  const removeEntry = (index: number) => {
    const updated = { ...value };
    delete updated[entries[index][0]];
    if (Object.keys(updated).length === 0) {
      onChange(undefined);
    } else {
      onChange(updated);
    }
  };

  const addEntry = () => {
    const updated = { ...value, "": "" };
    onChange(updated);
  };

  return (
    <div>
      {entries.map(([k, v], i) => (
        <div
          key={`${k}-${i}`}
          style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}
        >
          <input
            value={k}
            onChange={(e) => updateEntry(i, "key", e.target.value)}
            placeholder={keyPlaceholder}
            readOnly={readOnly}
            style={{ width: "30%" }}
          />
          <input
            value={v}
            onChange={(e) => updateEntry(i, "value", e.target.value)}
            placeholder={valuePlaceholder}
            readOnly={readOnly}
            style={{ flex: 1 }}
          />
          {!readOnly && (
            <button
              type="button"
              onClick={() => removeEntry(i)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                border: "none",
                background: "none",
                color: "#9ca3af",
                cursor: "pointer",
                borderRadius: 4,
                padding: 0,
                flexShrink: 0,
              }}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          onClick={addEntry}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            border: "none",
            background: "none",
            color: "#6b7280",
            cursor: "pointer",
            fontSize: 11,
            padding: 0,
          }}
        >
          <Plus size={12} /> {addLabel}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 在 shell 节点配置区（第 133 行 `</>` 闭合之前，env 字段之后）插入 inputs 编辑区**

在 `web/src/pages/workflow/components/NodeConfigPanel.tsx` 中，shell 配置区的 env textarea 闭合 `</div>` 之后、`</>` 之前，添加：

```tsx
<div className="wf-prop-field">
  <label>{t("editor.inputs_title")}</label>
  <InputsEditor
    value={sd?.inputs as Record<string, string> | undefined}
    onChange={(val) => {
      const cleaned: Record<string, string> = {};
      if (val) {
        for (const [k, v] of Object.entries(val)) {
          if (k.trim()) cleaned[k.trim()] = v;
        }
      }
      updateNodeData({ inputs: Object.keys(cleaned).length ? cleaned : undefined });
    }}
    readOnly={readOnly}
    keyPlaceholder={t("editor.inputs_key_placeholder")}
    valuePlaceholder={t("editor.inputs_value_placeholder")}
    addLabel={t("editor.inputs_add")}
  />
</div>
```

- [ ] **Step 4: 在 python 节点配置区（第 181 行 env textarea 闭合 `</div>` 之后、`</>` 之前）插入同样的 inputs 编辑区**

python 配置区的 env textarea 闭合 `</div>` 之后、`</>` 之前，添加与 Step 3 完全相同的代码块。

- [ ] **Step 5: 验证编译通过**

```bash
bun run build:web
```

预期：编译成功，无 TypeScript 错误。

- [ ] **Step 6: 提交 inputs 编辑器改动**

```bash
git add web/src/pages/workflow/components/NodeConfigPanel.tsx
git commit -m "feat: workflow shell/python 节点新增 inputs 键值对编辑器"
```

---

### Task 4: 端到端验证

- [ ] **Step 1: 启动前端开发服务器**

```bash
bun run dev:web
```

- [ ] **Step 2: 在浏览器中验证画布布局**

1. 打开 workflow 编辑器，创建新工作流
2. 拖拽添加多个节点（shell、python、agent）
3. 连线确认 edges 从上到下流动
4. 点击自动布局按钮，确认节点按 TB 方向排列
5. 确认 Handle 点在节点上方（target）和下方（source）

- [ ] **Step 3: 验证 inputs 编辑器**

1. 选中一个 shell 节点
2. 在右侧面板找到 "Inputs" 区域
3. 点击 "添加 Input" 按钮，确认新增一行
4. 填写 key（如 `RESULT`）和 value（如 `${{ nodes.step1.stdout }}`）
5. 点击删除按钮，确认行被移除
6. 打开 YAML 面板，确认 inputs 字段正确序列化
7. 选中 python 节点，重复上述验证
8. 选中 agent 节点，确认没有 Inputs 编辑区域

- [ ] **Step 4: 运行 precheck**

```bash
bun run precheck
```

预期：全部通过。

- [ ] **Step 5: 提交最终验证**

如有任何自动修复（格式化/import 排序），提交修复：

```bash
git add -A
git commit -m "chore: precheck 修复"
```
