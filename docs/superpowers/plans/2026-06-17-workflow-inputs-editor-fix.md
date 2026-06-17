# Workflow Inputs 编辑器修复与交互增强

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复"添加 Input"按钮完全无效的 bug，并改善 InputsEditor 组件的交互体验使其达到生产级别。

**Architecture:** 移除 `NodeConfigCard.tsx` 中 `onChange` 回调对空 key 的过度过滤（根因），让 `InputsEditor` 的新行能正常渲染。同时在 `InputsEditor` 内部增加删除确认、Enter 键新增行、格式提示等交互增强。YAML 序列化（`flowToYaml` L182）已有 `v !== ""` 防御，保存时自动过滤脏数据。

**Tech Stack:** React 19, TypeScript, react-i18next, Radix Popover

---

## File Structure

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `web/src/pages/workflow/components/NodeConfigCard.tsx` | 移除 inputs/output onChange 中的 cleaned 过滤逻辑（4 处） | 修改 |
| `web/src/pages/workflow/components/InputsEditor.tsx` | 增加删除确认、Enter 键新增行、value placeholder 提示 | 重写 |
| `web/src/i18n/locales/zh/workflows.json` | 新增中文翻译键 | 修改 |
| `web/src/i18n/locales/en/workflows.json` | 新增英文翻译键 | 修改 |

---

### Task 1: 修复 NodeConfigCard.tsx — 4 处 onChange 回调

**Files:**
- Modify: `web/src/pages/workflow/components/NodeConfigCard.tsx:115-123`
- Modify: `web/src/pages/workflow/components/NodeConfigCard.tsx:182-190`
- Modify: `web/src/pages/workflow/components/NodeConfigCard.tsx:372-379`
- Modify: `web/src/pages/workflow/components/NodeConfigCard.tsx:389-408`

- [ ] **Step 1: 修复 shell 节点 inputs onChange (L115-123)**

替换以下代码（第 115-123 行）：

```tsx
                    onChange={(val) => {
                      const cleaned: Record<string, string> = {};
                      if (val) {
                        for (const [k, v] of Object.entries(val)) {
                          if (k.trim()) cleaned[k.trim()] = v;
                        }
                      }
                      updateNodeData({ inputs: Object.keys(cleaned).length ? cleaned : undefined });
                    }}
```

为：

```tsx
                    onChange={(val) => {
                      updateNodeData({ inputs: val && Object.keys(val).length > 0 ? val : undefined });
                    }}
```

- [ ] **Step 2: 修复 python 节点 inputs onChange (L182-190)**

替换以下代码（第 182-190 行）：

```tsx
                    onChange={(val) => {
                      const cleaned: Record<string, string> = {};
                      if (val) {
                        for (const [k, v] of Object.entries(val)) {
                          if (k.trim()) cleaned[k.trim()] = v;
                        }
                      }
                      updateNodeData({ inputs: Object.keys(cleaned).length ? cleaned : undefined });
                    }}
```

为：

```tsx
                    onChange={(val) => {
                      updateNodeData({ inputs: val && Object.keys(val).length > 0 ? val : undefined });
                    }}
```

- [ ] **Step 3: 修复 transform 节点 inputs onChange (L372-379)**

替换以下代码（第 372-379 行）：

```tsx
                    onChange={(val) => {
                      const cleaned: Record<string, string> = {};
                      if (val) {
                        for (const [k, v] of Object.entries(val)) {
                          if (k.trim()) cleaned[k.trim()] = v;
                        }
                      }
                      updateNodeData({ inputs: Object.keys(cleaned).length ? cleaned : undefined });
                    }}
```

为：

```tsx
                    onChange={(val) => {
                      updateNodeData({ inputs: val && Object.keys(val).length > 0 ? val : undefined });
                    }}
```

- [ ] **Step 4: 修复 transform 节点 output onChange (L389-408)**

替换以下代码（第 391-401 行）：

```tsx
                    onChange={(val) => {
                      const cleaned: Record<string, string> = {};
                      if (val) {
                        for (const [k, v] of Object.entries(val)) {
                          if (k.trim()) cleaned[k.trim()] = v;
                        }
                      }
                      // 检测 key 名变更并自动同步表达式中的同名引用
                      const oldOutput = (sd?.output as Record<string, string>) ?? {};
                      const synced = syncOutputOnRename(oldOutput, cleaned);
                      updateNodeData({ output: Object.keys(synced).length ? synced : undefined });
                    }}
```

为：

```tsx
                    onChange={(val) => {
                      if (!val || Object.keys(val).length === 0) {
                        updateNodeData({ output: undefined });
                        return;
                      }
                      // 检测 key 名变更并自动同步表达式中的同名引用
                      const oldOutput = (sd?.output as Record<string, string>) ?? {};
                      const synced = syncOutputOnRename(oldOutput, val);
                      updateNodeData({ output: synced });
                    }}
```

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/workflow/components/NodeConfigCard.tsx
git commit -m "fix(workflow): 修复添加 Input/Output 按钮无效 — 移除 onChange 中过度过滤空 key 的逻辑

根因: InputsEditor.addEntry() 添加 {\"\":\"\"} 空行, 但 NodeConfigCard 的 onChange
回调立即用 k.trim() 过滤掉空 key, 导致新行从未渲染, 按钮完全无效果。

修复: 移除 onChange 中的 cleaned 过滤逻辑, 直接透传 val。
YAML 序列化 (flowToYaml L182) 已有 v !== \"\" 的防御, 保存时自动过滤脏数据。

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 2: 添加 i18n 翻译键

**Files:**
- Modify: `web/src/i18n/locales/zh/workflows.json` — 在 `editor` 对象末尾追加
- Modify: `web/src/i18n/locales/en/workflows.json` — 在 `editor` 对象末尾追加

- [ ] **Step 1: 添加中文翻译键**

在 `web/src/i18n/locales/zh/workflows.json` 的 `editor` 对象末尾（`"vi_preview_mode"` 行之后）追加：

```json
    "vi_preview_mode": "预览中",
    "inputs_delete_confirm": "删除此输入？",
    "inputs_value_hint": "如 nodes.shell_1.output",
    "inputs_enter_to_add": "按 Enter 新增一行",
    "output_delete_confirm": "删除此输出？",
    "output_value_hint": "如 data.items.map(i => i.name)",
    "output_enter_to_add": "按 Enter 新增一行"
```

- [ ] **Step 2: 添加英文翻译键**

在 `web/src/i18n/locales/en/workflows.json` 的 `editor` 对象末尾（`"vi_preview_mode"` 行之后）追加：

```json
    "vi_preview_mode": "Previewing",
    "inputs_delete_confirm": "Delete this input?",
    "inputs_value_hint": "e.g. nodes.shell_1.output",
    "inputs_enter_to_add": "Press Enter to add a row",
    "output_delete_confirm": "Delete this output?",
    "output_value_hint": "e.g. data.items.map(i => i.name)",
    "output_enter_to_add": "Press Enter to add a row"
```

- [ ] **Step 3: 提交**

```bash
git add web/src/i18n/locales/zh/workflows.json web/src/i18n/locales/en/workflows.json
git commit -m "i18n(workflow): 添加 InputsEditor 删除确认/格式提示/Enter 提示的翻译键

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 3: 增强 InputsEditor 交互 — 删除确认 + Enter 键 + 格式提示

**Files:**
- Modify: `web/src/pages/workflow/components/InputsEditor.tsx` — 完整重写
- Modify: `web/src/pages/workflow/components/NodeConfigCard.tsx` — 传递新增 props

- [ ] **Step 1: 重写 InputsEditor 组件**

将 `web/src/pages/workflow/components/InputsEditor.tsx` 完整替换为：

```tsx
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function InputsEditor({
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
  const { t } = useTranslation("workflows");
  const entries = Object.entries(value ?? {});
  // 跟踪待删除确认的条目的 key（用 key 而非 index，避免增删行时 index 错位）
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  // 自动取消确认的计时器
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 各个输入框的 ref，用于新增行后自动聚焦
  const keyRefs = useRef<(HTMLInputElement | null)[]>([]);

  // 当 value 变化（entries 增删）时取消确认状态，避免高亮错位
  const entriesLen = entries.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only reset when entry count changes
  useEffect(() => {
    setConfirmDeleteKey(null);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, [entriesLen]);

  // 组件卸载时清理计时器
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

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
    onChange(Object.keys(updated).length === 0 ? undefined : updated);
  };

  const handleDeleteClick = (index: number) => {
    const entryKey = entries[index][0];
    if (confirmDeleteKey === entryKey) {
      // 二次确认：真正删除
      removeEntry(index);
      setConfirmDeleteKey(null);
    } else {
      // 首次点击：进入确认状态
      setConfirmDeleteKey(entryKey);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDeleteKey(null), 3000);
    }
  };

  const addEntry = () => {
    const updated = { ...value, "": "" };
    onChange(updated);
    // 在下一帧渲染后聚焦新行的 key 输入框
    requestAnimationFrame(() => {
      const lastIdx = Object.keys(updated).length - 1;
      keyRefs.current[lastIdx]?.focus();
    });
  };

  // 在最后一个输入框按 Enter 时新增一行
  const handleKeyDown = (e: React.KeyboardEvent, index: number, field: "key" | "value") => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (field !== "value") return;
    const isLastEntry = index === entries.length - 1;
    if (!isLastEntry) return;
    e.preventDefault();
    addEntry();
  };

  return (
    <div>
      {entries.map(([k, v], i) => {
        const isConfirming = confirmDeleteKey === k && k !== "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep input focus stable when key is being edited
          <div key={`${k}-${i}`} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
            <input
              ref={(el) => { keyRefs.current[i] = el; }}
              value={k}
              onChange={(e) => updateEntry(i, "key", e.target.value)}
              placeholder={keyPlaceholder}
              readOnly={readOnly}
              style={{
                width: "30%",
                // 空 key 视觉警告：红色边框
                ...(k.trim() === "" ? { borderColor: "#fca5a5", background: "#fef2f2" } : {}),
              }}
            />
            <input
              value={v}
              onChange={(e) => updateEntry(i, "value", e.target.value)}
              placeholder={valuePlaceholder}
              readOnly={readOnly}
              onKeyDown={(e) => handleKeyDown(e, i, "value")}
              title={t("editor.inputs_enter_to_add")}
              style={{ flex: 1 }}
            />
            {!readOnly && (
              <button
                type="button"
                onClick={() => handleDeleteClick(i)}
                title={isConfirming ? t("components:confirm") : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 24,
                  height: 24,
                  border: "none",
                  background: isConfirming ? "#fef2c7" : "none",
                  color: isConfirming ? "#ef4444" : "#9ca3af",
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
        );
      })}
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

- [ ] **Step 2: 更新 NodeConfigCard 中 InputsEditor 的 valuePlaceholder，传入格式提示**

在 `NodeConfigCard.tsx` 中，将 shell 节点（L126）和 python 节点（L193）的 `valuePlaceholder` 从静态翻译改为带提示的翻译：

```tsx
// shell 节点 L126 处:
                    valuePlaceholder={t("editor.inputs_value_hint")}
```

```tsx
// python 节点 L193 处:
                    valuePlaceholder={t("editor.inputs_value_hint")}
```

```tsx
// transform inputs L383 处:
                    valuePlaceholder={t("editor.inputs_value_hint")}
```

```tsx
// transform output L405 处:
                    valuePlaceholder={t("editor.output_value_hint")}
```

- [ ] **Step 3: 运行现有前端测试验证无回归**

```bash
bun test web/src/__tests__/
```

期望: 全部通过（不应该因为此变更而引入新失败）。

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/components/InputsEditor.tsx web/src/pages/workflow/components/NodeConfigCard.tsx
git commit -m "feat(workflow): InputsEditor 交互增强 — 删除二次确认 + Enter 新增行 + 格式提示

- 删除：首次点击变黄高亮, 再次点击确认删除; 3秒自动取消; 用 key 跟踪避免增删时错位
- Enter：最后一个 value 输入框按 Enter 自动新增一行并聚焦新行的 key
- 提示：value placeholder 改为格式提示 (如 nodes.XXX.output); title 提示 Enter 热键
- 视觉：空 key 输入框红色边框警告; 新增行自动聚焦; 组件卸载清理计时器
- 安全：entries 数量变化时自动取消确认状态 (避免高亮错位)

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 4: 运行 precheck + 全部测试

- [ ] **Step 1: 运行 precheck**

```bash
bun run precheck
```

期望: format, import sorting, tsc, biome check 全部通过。

- [ ] **Step 2: 运行全部后端测试**

```bash
bun test src/__tests__/
```

期望: 全部通过。

- [ ] **Step 3: 运行全部前端测试**

```bash
bun test web/src/__tests__/
```

期望: 全部通过。

---

### Task 5: 构建并最终验证

- [ ] **Step 1: 构建前端**

```bash
bun run build:web
```

- [ ] **Step 2: 最终提交（如有 precheck 自动修复的文件变更）**

```bash
git add -A && git diff --cached --stat
git commit -m "chore(workflow): precheck 自动修复 — format + import 排序

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```
