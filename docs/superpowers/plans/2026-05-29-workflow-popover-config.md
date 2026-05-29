# 工作流 Popover 卡片配置面板 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将工作流编辑器右侧固定侧边栏替换为节点点击弹出的 Popover 卡片 + 工具栏触发的独立 Sheet，最大化画布可视区域。

**Architecture:** 移除 `wf-prop-panel` 侧边栏。节点配置通过 Radix Popover（shadcn）在节点右侧弹出；工作流元数据通过右下角固定锚点 Popover 编辑；Run/Versions/Triggers 通过 shadcn Sheet 从右侧滑出。状态管理从 `rightTab` 字符串切换为三个布尔值。

**Tech Stack:** React 19, @xyflow/react, Radix Popover (shadcn/ui), Radix Dialog Sheet (shadcn/ui), Tailwind CSS, i18next

---

## File Structure

| 操作 | 文件路径 | 职责 |
|------|----------|------|
| 修改 | `web/src/pages/workflow/nodes.tsx` | 添加 `data-node-id` 属性 |
| 新建 | `web/src/pages/workflow/components/InputsEditor.tsx` | 从 NodeConfigPanel 提取的共享 key-value 编辑器 |
| 新建 | `web/src/pages/workflow/components/NodeConfigCard.tsx` | 节点配置纯表单（从 NodeConfigPanel 提取） |
| 新建 | `web/src/pages/workflow/components/WorkflowMetaCard.tsx` | 工作流元数据纯表单（从 NodeConfigPanel 提取） |
| 新建 | `web/src/pages/workflow/components/NodeConfigPopover.tsx` | Popover 外壳包裹 NodeConfigCard |
| 新建 | `web/src/pages/workflow/components/WorkflowMetaPopover.tsx` | 右下角固定 Popover 包裹 WorkflowMetaCard |
| 修改 | `web/src/pages/workflow/WorkflowEditor.tsx` | 主要改造：移除侧边栏，编排 Popover/Sheet |
| 修改 | `web/src/pages/workflow/hooks/useWorkflowRun.ts` | `setRightTab` 改为 `openRunSheet` 回调 |
| 修改 | `web/src/pages/workflow/components/RunStatusPanel.tsx` | `onClose` 回调适配 Sheet 关闭 |
| 修改 | `web/src/pages/workflow/workflow.css` | 移除侧边栏样式，新增 popover 样式 |
| 修改 | `web/src/i18n/locales/en/workflows.json` | 新增 popover 标题 i18n key |
| 修改 | `web/src/i18n/locales/zh/workflows.json` | 新增 popover 标题 i18n key |

---

### Task 1: nodes.tsx 添加 data-node-id

**Files:**
- Modify: `web/src/pages/workflow/nodes.tsx:141` (WorkflowNode 组件外层 div)

- [ ] **Step 1: 给节点组件添加 data-node-id 属性**

在 `web/src/pages/workflow/nodes.tsx` 的 `WorkflowNode` 组件中，给外层 `div` 添加 `data-node-id` 属性。

将第 141 行的：
```tsx
<div
  style={{
    background: "#fff",
    borderRadius: 8,
```

改为：
```tsx
<div
  data-node-id={id}
  style={{
    background: "#fff",
    borderRadius: 8,
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/nodes.tsx
git commit -m "feat(workflow): add data-node-id attribute to workflow node DOM"
```

---

### Task 2: 提取 InputsEditor 到独立文件

**Files:**
- Create: `web/src/pages/workflow/components/InputsEditor.tsx`
- Modify: `web/src/pages/workflow/components/NodeConfigPanel.tsx`

- [ ] **Step 1: 创建 InputsEditor.tsx**

将 `NodeConfigPanel.tsx` 中第 21-129 行的 `InputsEditor` 组件原样提取到新文件。

创建 `web/src/pages/workflow/components/InputsEditor.tsx`：

```tsx
import { Plus, Trash2 } from "lucide-react";

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
        // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep input focus stable when key is being edited
        <div key={`${k}-${i}`} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
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

- [ ] **Step 2: 更新 NodeConfigPanel.tsx 的 import**

在 `web/src/pages/workflow/components/NodeConfigPanel.tsx` 中：

1. 删除 `import { Lock, Plus, Trash2 } from "lucide-react";` 中的 `Plus, Trash2`，改为 `import { Lock } from "lucide-react";`
2. 添加 `import { InputsEditor } from "./InputsEditor";`
3. 删除第 21-129 行的 `InputsEditor` 函数定义（从 `function InputsEditor({` 到对应的结尾 `}`）

- [ ] **Step 3: 验证构建通过**

Run: `bun run build:web`
Expected: 构建成功，无 TypeScript 错误

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/workflow/components/InputsEditor.tsx web/src/pages/workflow/components/NodeConfigPanel.tsx
git commit -m "refactor(workflow): extract InputsEditor to shared component"
```

---

### Task 3: 创建 NodeConfigCard 组件

**Files:**
- Create: `web/src/pages/workflow/components/NodeConfigCard.tsx`

- [ ] **Step 1: 创建 NodeConfigCard.tsx**

从 `NodeConfigPanel.tsx` 的 `NodeConfigPanel` 函数中提取"开始节点"和"选中节点"两个分支的逻辑（第 147-525 行的 `isStartNode ? ... : selectedNode ? ...` 部分），包裹为独立的纯表单组件。

创建 `web/src/pages/workflow/components/NodeConfigCard.tsx`：

```tsx
import type { Node } from "@xyflow/react";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WfMeta } from "../yaml-utils";
import { START_NODE_ID } from "../yaml-utils";
import { InputsEditor } from "./InputsEditor";

export interface NodeConfigCardProps {
  readOnly: boolean;
  selectedNode: Node;
  sd: Record<string, unknown> | undefined;
  nodeType: string;
  handleIdChange: (newId: string) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setSelectedNode: React.Dispatch<React.SetStateAction<Node | null>>;
  updateNodeData: (patch: Record<string, unknown>) => void;
  agentList: Array<{ name: string; description: string | null }>;
}

export function NodeConfigCard({
  readOnly,
  selectedNode,
  sd,
  nodeType,
  handleIdChange,
  setNodes,
  setSelectedNode,
  updateNodeData,
  agentList,
}: NodeConfigCardProps) {
  const { t } = useTranslation("workflows");
  const isStartNode = selectedNode.id === START_NODE_ID;

  return (
    <div className="wf-popover-body">
      {readOnly && (
        <div
          style={{
            padding: "4px 12px",
            background: "#fefce8",
            borderBottom: "1px solid #fde68a",
            fontSize: 10,
            color: "#92400e",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Lock size={10} /> {t("editor.readonly")}
        </div>
      )}
      {/* 开始节点 */}
      {isStartNode ? (
        <div className="wf-prop-section">
          <div className="wf-prop-section-title">{t("editor.start_node_title")}</div>
          <div className="wf-prop-hint">
            <p>{t("editor.start_node_hint_1")}</p>
            <p>{t("editor.start_node_hint_2")}</p>
          </div>
        </div>
      ) : (
        <>
          {/* 节点基本信息 */}
          <div className="wf-prop-section">
            <div className="wf-prop-section-title">{t("editor.basic_info")}</div>
            <div className="wf-prop-field">
              <label>{t("editor.node_id")}</label>
              <input value={selectedNode.id} onChange={(e) => handleIdChange(e.target.value)} readOnly={readOnly} />
            </div>
            <div className="wf-prop-field">
              <label>{t("editor.type")}</label>
              <select
                value={nodeType}
                onChange={(e) => {
                  const newType = e.target.value;
                  setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, type: newType } : n)));
                  setSelectedNode((prev) => (prev ? { ...prev, type: newType } : null));
                }}
                disabled={readOnly}
              >
                <option value="shell">{t("editor.type_shell")}</option>
                <option value="python">{t("editor.type_python")}</option>
                <option value="agent">{t("editor.type_agent")}</option>
                <option value="api">{t("editor.type_api")}</option>
                <option value="audit">{t("editor.type_audit")}</option>
                <option value="workflow">{t("editor.type_workflow")}</option>
                <option value="loop">{t("editor.type_loop")}</option>
              </select>
            </div>
            <div className="wf-prop-field">
              <label>{t("editor.description")}</label>
              <input
                value={String(sd?.description ?? "")}
                onChange={(e) => updateNodeData({ description: e.target.value || undefined })}
                placeholder={t("editor.description_placeholder")}
                readOnly={readOnly}
              />
            </div>
          </div>

          {/* 节点配置（按类型） */}
          <div className="wf-prop-section">
            <div className="wf-prop-section-title">{t("editor.config")}</div>

            {nodeType === "shell" && (
              <>
                <div className="wf-prop-field">
                  <label>{t("editor.shell_command")}</label>
                  <textarea
                    value={String(sd?.command ?? "")}
                    onChange={(e) => updateNodeData({ command: e.target.value })}
                    placeholder='echo "Hello ${{ params.name }}"'
                    rows={3}
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>{t("editor.shell_env")}</label>
                  <textarea
                    value={String(sd?.env ?? "")}
                    onChange={(e) => updateNodeData({ env: e.target.value })}
                    placeholder={t("editor.shell_env_placeholder")}
                    rows={2}
                    readOnly={readOnly}
                  />
                </div>
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
              </>
            )}

            {nodeType === "python" && (
              <>
                <div className="wf-prop-field">
                  <label>{t("editor.python_code")}</label>
                  <textarea
                    value={String(sd?.code ?? "")}
                    onChange={(e) => updateNodeData({ code: e.target.value })}
                    placeholder={'import json\nprint(json.dumps({"result": "hello"}))'}
                    rows={6}
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>{t("editor.python_requirements")}</label>
                  <textarea
                    value={
                      Array.isArray(sd?.requirements)
                        ? (sd.requirements as string[]).join("\n")
                        : String(sd?.requirements ?? "")
                    }
                    onChange={(e) =>
                      updateNodeData({
                        requirements: e.target.value
                          ? e.target.value
                              .split("\n")
                              .map((s: string) => s.trim())
                              .filter(Boolean)
                          : undefined,
                      })
                    }
                    placeholder={t("editor.python_requirements_placeholder")}
                    rows={2}
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>{t("editor.shell_env")}</label>
                  <textarea
                    value={String(sd?.env ?? "")}
                    onChange={(e) => updateNodeData({ env: e.target.value })}
                    placeholder={t("editor.shell_env_placeholder")}
                    rows={2}
                    readOnly={readOnly}
                  />
                </div>
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
              </>
            )}

            {nodeType === "agent" && (
              <>
                <div className="wf-prop-field">
                  <label>{t("editor.agent_env")}</label>
                  <select
                    value={String(sd?.agent ?? "")}
                    onChange={(e) => updateNodeData({ agent: e.target.value || undefined })}
                    disabled={readOnly}
                  >
                    <option value="">{t("editor.agent_select_env")}</option>
                    {agentList.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name}
                        {a.description ? ` - ${a.description}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="wf-prop-field">
                  <label>{t("editor.agent_prompt")}</label>
                  <textarea
                    value={String(sd?.prompt ?? "")}
                    onChange={(e) => updateNodeData({ prompt: e.target.value })}
                    placeholder={t("editor.agent_prompt_placeholder")}
                    rows={4}
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>{t("editor.agent_output_messages")}</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={sd?.output_messages != null ? String(sd.output_messages) : ""}
                    onChange={(e) =>
                      updateNodeData({ output_messages: e.target.value ? Number(e.target.value) : undefined })
                    }
                    placeholder="0"
                    readOnly={readOnly}
                  />
                </div>
              </>
            )}

            {nodeType === "api" && (
              <>
                <div className="wf-prop-field">
                  <label>URL</label>
                  <input
                    value={String(sd?.url ?? "")}
                    onChange={(e) => updateNodeData({ url: e.target.value })}
                    placeholder="https://api.example.com/data"
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>{t("editor.api_method")}</label>
                  <select
                    value={String(sd?.method ?? "GET")}
                    onChange={(e) => updateNodeData({ method: e.target.value })}
                    disabled={readOnly}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                    <option value="DELETE">DELETE</option>
                  </select>
                </div>
                <div className="wf-prop-field">
                  <label>{t("editor.api_headers")}</label>
                  <textarea
                    value={String(sd?.headers ?? "")}
                    onChange={(e) => updateNodeData({ headers: e.target.value })}
                    placeholder='{"Authorization": "Bearer ${{ secrets.KEY }}"}'
                    rows={2}
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>{t("editor.api_body")}</label>
                  <textarea
                    value={String(sd?.body ?? "")}
                    onChange={(e) => updateNodeData({ body: e.target.value })}
                    placeholder='{"key": "value"}'
                    rows={2}
                    readOnly={readOnly}
                  />
                </div>
              </>
            )}

            {nodeType === "audit" && (
              <>
                <div className="wf-prop-field">
                  <label>{t("editor.audit_message")}</label>
                  <input
                    value={String(
                      (typeof sd?.display_data === "object" && sd?.display_data !== null
                        ? (sd.display_data as Record<string, string>).message
                        : sd?.display_data) ?? "",
                    )}
                    onChange={(e) => updateNodeData({ display_data: { message: e.target.value } })}
                    placeholder={t("editor.audit_message_placeholder")}
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>{t("editor.audit_expires")}</label>
                  <input
                    type="number"
                    value={sd?.expires_in != null ? String(sd.expires_in) : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateNodeData({ expires_in: v ? Number(v) : undefined });
                    }}
                    placeholder="86400"
                    readOnly={readOnly}
                  />
                </div>
              </>
            )}

            {nodeType === "workflow" && (
              <div className="wf-prop-field">
                <label>{t("editor.workflow_ref")}</label>
                <input
                  value={String(sd?.ref ?? "")}
                  onChange={(e) => updateNodeData({ ref: e.target.value })}
                  placeholder="./sub-workflow.yaml"
                  readOnly={readOnly}
                />
              </div>
            )}

            {nodeType === "loop" && (
              <>
                <div className="wf-prop-field">
                  <label>{t("editor.loop_condition")}</label>
                  <input
                    value={String(sd?.condition ?? "")}
                    onChange={(e) => updateNodeData({ condition: e.target.value })}
                    placeholder="{{ counter < 10 }}"
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-field">
                  <label>{t("editor.loop_max_iterations")}</label>
                  <input
                    type="number"
                    value={sd?.max_iterations != null ? String(sd.max_iterations) : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateNodeData({ max_iterations: v ? Number(v) : undefined });
                    }}
                    placeholder="10"
                    readOnly={readOnly}
                  />
                </div>
                <div className="wf-prop-hint" style={{ marginTop: 4 }}>
                  <p>{t("editor.loop_body_hint")}</p>
                </div>
              </>
            )}
          </div>

          {/* 高级配置 */}
          <div className="wf-prop-section">
            <div className="wf-prop-section-title">{t("editor.advanced")}</div>
            <div className="wf-prop-field">
              <label>{t("editor.timeout_seconds")}</label>
              <input
                type="number"
                value={sd?.timeout != null ? String(sd.timeout) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  updateNodeData({ timeout: v ? Number(v) : undefined });
                }}
                placeholder="300"
                readOnly={readOnly}
              />
            </div>
            <div className="wf-prop-field">
              <label>{t("editor.retry_count")}</label>
              <input
                type="number"
                value={sd?.retry != null ? String(sd.retry) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  updateNodeData({ retry: v ? Number(v) : undefined });
                }}
                placeholder="0"
                readOnly={readOnly}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/components/NodeConfigCard.tsx
git commit -m "feat(workflow): extract NodeConfigCard component from NodeConfigPanel"
```

---

### Task 4: 创建 WorkflowMetaCard 组件

**Files:**
- Create: `web/src/pages/workflow/components/WorkflowMetaCard.tsx`

- [ ] **Step 1: 创建 WorkflowMetaCard.tsx**

从 `NodeConfigPanel.tsx` 中提取"未选中节点"分支（工作流元数据编辑）的逻辑。

创建 `web/src/pages/workflow/components/WorkflowMetaCard.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import type { WfMeta } from "../yaml-utils";

export interface WorkflowMetaCardProps {
  readOnly: boolean;
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
}

export function WorkflowMetaCard({ readOnly, meta, updateMeta }: WorkflowMetaCardProps) {
  const { t } = useTranslation("workflows");

  return (
    <div className="wf-popover-body">
      <div className="wf-prop-section">
        <div className="wf-prop-section-title">{t("editor.basic_info")}</div>
        <div className="wf-prop-field">
          <label>{t("editor.schema_version")}</label>
          <input value={meta.schema_version} readOnly />
        </div>
        <div className="wf-prop-field">
          <label>{t("editor.name")}</label>
          <input value={meta.name} onChange={(e) => updateMeta({ name: e.target.value })} readOnly={readOnly} />
        </div>
        <div className="wf-prop-field">
          <label>{t("editor.meta_description")}</label>
          <textarea
            value={meta.description}
            onChange={(e) => updateMeta({ description: e.target.value })}
            placeholder={t("editor.meta_desc_placeholder")}
            rows={2}
            readOnly={readOnly}
          />
        </div>
        <div className="wf-prop-field">
          <label>{t("editor.timeout_seconds")}</label>
          <input
            type="number"
            value={meta.timeout}
            onChange={(e) => updateMeta({ timeout: e.target.value ? Number(e.target.value) : 300 })}
            placeholder="300"
            readOnly={readOnly}
          />
        </div>
      </div>

      <div className="wf-prop-section">
        <div className="wf-prop-section-title">{t("editor.params")}</div>
        <div className="wf-prop-field">
          <label>{t("editor.params_json")}</label>
          <textarea
            value={Object.keys(meta.params).length ? JSON.stringify(meta.params, null, 2) : ""}
            onChange={(e) => {
              try {
                const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : {};
                updateMeta({ params: parsed });
              } catch {
                // 用户还在编辑，暂不更新
              }
            }}
            placeholder='{"name": {"type": "string", "default": "World"}}'
            rows={3}
            readOnly={readOnly}
          />
        </div>
      </div>

      <div className="wf-prop-section">
        <div className="wf-prop-section-title">{t("editor.secrets")}</div>
        <div className="wf-prop-field">
          <label>{t("editor.secrets_env_names")}</label>
          <textarea
            value={meta.secrets.join("\n")}
            onChange={(e) =>
              updateMeta({
                secrets: e.target.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="API_KEY&#10;DATABASE_URL"
            rows={2}
            readOnly={readOnly}
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/components/WorkflowMetaCard.tsx
git commit -m "feat(workflow): extract WorkflowMetaCard component from NodeConfigPanel"
```

---

### Task 5: 创建 NodeConfigPopover 组件

**Files:**
- Create: `web/src/pages/workflow/components/NodeConfigPopover.tsx`

- [ ] **Step 1: 创建 NodeConfigPopover.tsx**

这个组件接收一个虚拟 anchor 元素（节点的 DOM），在节点右侧弹出 Popover 卡片。使用 Radix Popover 的 controlled 模式。

创建 `web/src/pages/workflow/components/NodeConfigPopover.tsx`：

```tsx
import type { Node } from "@xyflow/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { WfMeta } from "../yaml-utils";
import { NodeConfigCard } from "./NodeConfigCard";

export interface NodeConfigPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedNode: Node | null;
  sd: Record<string, unknown> | undefined;
  nodeType: string;
  readOnly: boolean;
  handleIdChange: (newId: string) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setSelectedNode: React.Dispatch<React.SetStateAction<Node | null>>;
  updateNodeData: (patch: Record<string, unknown>) => void;
  agentList: Array<{ name: string; description: string | null }>;
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
}

export function NodeConfigPopover({
  open,
  onOpenChange,
  selectedNode,
  sd,
  nodeType,
  readOnly,
  handleIdChange,
  setNodes,
  setSelectedNode,
  updateNodeData,
  agentList,
}: NodeConfigPopoverProps) {
  const { t } = useTranslation("workflows");
  const anchorRef = useRef<HTMLElement | null>(null);

  // 当 selectedNode 变化时，找到对应的 DOM 元素作为 anchor
  useEffect(() => {
    if (selectedNode) {
      const el = document.querySelector(`[data-node-id="${selectedNode.id}"]`);
      anchorRef.current = el as HTMLElement;
    }
  }, [selectedNode]);

  if (!selectedNode) return null;

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      <PopoverAnchor
        ref={anchorRef}
        style={{
          position: "fixed",
          left: anchorRef.current ? anchorRef.current.getBoundingClientRect().right + 4 : 0,
          top: anchorRef.current ? anchorRef.current.getBoundingClientRect().top : 0,
          width: 1,
          height: anchorRef.current ? anchorRef.current.getBoundingClientRect().height : 1,
          pointerEvents: "none",
        }}
      />
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        className="wf-node-popover"
        onInteractOutside={(e) => {
          // 允许在 popover 内正常操作
          const target = e.target as HTMLElement;
          if (target.closest(".wf-node-popover")) {
            e.preventDefault();
          }
        }}
      >
        <div className="wf-popover-header">
          <span className="wf-popover-title">{selectedNode.id}</span>
          <span className="wf-popover-type">{t(`nodes.${nodeType}`)}</span>
        </div>
        <NodeConfigCard
          readOnly={readOnly}
          selectedNode={selectedNode}
          sd={sd}
          nodeType={nodeType}
          handleIdChange={handleIdChange}
          setNodes={setNodes}
          setSelectedNode={setSelectedNode}
          updateNodeData={updateNodeData}
          agentList={agentList}
        />
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/components/NodeConfigPopover.tsx
git commit -m "feat(workflow): create NodeConfigPopover component"
```

---

### Task 6: 创建 WorkflowMetaPopover 组件

**Files:**
- Create: `web/src/pages/workflow/components/WorkflowMetaPopover.tsx`

- [ ] **Step 1: 创建 WorkflowMetaPopover.tsx**

右下角固定锚点的 Popover，用于编辑工作流元数据。锚点是一个半透明的齿轮图标按钮。

创建 `web/src/pages/workflow/components/WorkflowMetaPopover.tsx`：

```tsx
import { Settings } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { WfMeta } from "../yaml-utils";
import { WorkflowMetaCard } from "./WorkflowMetaCard";

export interface WorkflowMetaPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnly: boolean;
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
}

export function WorkflowMetaPopover({ open, onOpenChange, readOnly, meta, updateMeta }: WorkflowMetaPopoverProps) {
  const { t } = useTranslation("workflows");
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="wf-meta-popover-anchor">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger ref={triggerRef} asChild>
          <button
            type="button"
            className="wf-meta-trigger-btn"
            title={t("editor.meta_settings")}
          >
            <Settings size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="wf-meta-popover"
        >
          <div className="wf-popover-header">
            <span className="wf-popover-title">{t("editor.meta_settings")}</span>
          </div>
          <WorkflowMetaCard readOnly={readOnly} meta={meta} updateMeta={updateMeta} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/components/WorkflowMetaPopover.tsx
git commit -m "feat(workflow): create WorkflowMetaPopover component"
```

---

### Task 7: 更新 i18n 翻译文件

**Files:**
- Modify: `web/src/i18n/locales/en/workflows.json`
- Modify: `web/src/i18n/locales/zh/workflows.json`

- [ ] **Step 1: 在英文翻译文件中添加新 key**

在 `web/src/i18n/locales/en/workflows.json` 的 `editor` 对象中，在 `"tab_triggers": "Triggers",` 行之后添加：

```json
"meta_settings": "Workflow Settings",
```

- [ ] **Step 2: 在中文翻译文件中添加新 key**

在 `web/src/i18n/locales/zh/workflows.json` 的 `editor` 对象中，在 `"tab_triggers": "触发器",` 行之后添加：

```json
"meta_settings": "工作流设置",
```

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/locales/en/workflows.json web/src/i18n/locales/zh/workflows.json
git commit -m "feat(workflow): add i18n keys for popover config panel"
```

---

### Task 8: 更新 CSS — 添加 popover 样式

**Files:**
- Modify: `web/src/pages/workflow/workflow.css`

- [ ] **Step 1: 添加 popover 样式**

在 `web/src/pages/workflow/workflow.css` 文件末尾追加以下样式：

```css
/* ── Node Config Popover ── */
.wf-node-popover {
  width: 320px;
  max-height: 480px;
  overflow-y: auto;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
  box-shadow:
    0 4px 16px rgba(0, 0, 0, 0.1),
    0 0 0 1px rgba(0, 0, 0, 0.04);
  padding: 0;
  background: #fff;
}

.wf-meta-popover {
  width: 320px;
  max-height: 520px;
  overflow-y: auto;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
  box-shadow:
    0 4px 16px rgba(0, 0, 0, 0.1),
    0 0 0 1px rgba(0, 0, 0, 0.04);
  padding: 0;
  background: #fff;
}

.wf-popover-header {
  padding: 8px 14px;
  border-bottom: 1px solid #f3f4f6;
  display: flex;
  align-items: center;
  gap: 8px;
  position: sticky;
  top: 0;
  background: #fff;
  z-index: 1;
  border-radius: 12px 12px 0 0;
}

.wf-popover-title {
  font-size: 12px;
  font-weight: 600;
  color: #111827;
}

.wf-popover-type {
  font-size: 10px;
  color: #6b7280;
  background: #f3f4f6;
  padding: "1px 6px";
  border-radius: 99;
}

.wf-popover-body {
  padding: 4px 0;
}

/* ── Meta Popover Anchor (bottom-right) ── */
.wf-meta-popover-anchor {
  position: absolute;
  bottom: 12px;
  right: 12px;
  z-index: 5;
}

.wf-meta-trigger-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  background: rgba(255, 255, 255, 0.9);
  color: #6b7280;
  cursor: pointer;
  transition: all 0.15s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(4px);
}

.wf-meta-trigger-btn:hover {
  background: #fff;
  color: #374151;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/workflow.css
git commit -m "feat(workflow): add popover card CSS styles"
```

---

### Task 9: 修改 useWorkflowRun hook — setRightTab 改为 openRunSheet

**Files:**
- Modify: `web/src/pages/workflow/hooks/useWorkflowRun.ts`

- [ ] **Step 1: 修改接口参数类型**

在 `web/src/pages/workflow/hooks/useWorkflowRun.ts` 中：

将 `UseWorkflowRunParams` 接口中的：
```ts
rightTab: string;
setRightTab: (tab: "config" | "run" | "versions") => void;
```

替换为：
```ts
openRunSheet: () => void;
```

- [ ] **Step 2: 修改解构**

将 hook 函数体中的解构：
```ts
setRightTab,
```

替换为：
```ts
openRunSheet,
```

- [ ] **Step 3: 替换所有 setRightTab 调用**

将所有 `setRightTab("run")` 替换为 `openRunSheet()`。

将所有 `setRightTab("config")` 替换为删除（这些是在 `handleBackToEdit` 中，回到编辑模式时不需要打开任何 Sheet）。

具体替换点：
- 第 283 行：`setRightTab("run");` → `openRunSheet();`
- 第 303 行：`setRightTab,` → `openRunSheet,`（依赖数组）
- 第 346 行：`setRightTab("config");` → 删除此行（handleBackToEdit 中不需要打开 Sheet）
- 第 355 行：`setRightTab,` → 删除（handleBackToEdit 的依赖数组中移除）
- 第 419 行：`setRightTab("run");` → `openRunSheet();`
- 第 440 行：`setRightTab,` → `openRunSheet,`
- 第 453 行：`setRightTab("run");` → `openRunSheet();`
- 第 464 行：`setRightTab,` → `openRunSheet,`

- [ ] **Step 4: 验证构建**

Run: `bun run build:web`
Expected: 构建失败（WorkflowEditor 还未更新调用方式），确认 useWorkflowRun.ts 本身无类型错误即可

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/workflow/hooks/useWorkflowRun.ts
git commit -m "refactor(workflow): replace setRightTab with openRunSheet in useWorkflowRun"
```

---

### Task 10: 修改 RunStatusPanel — onClose 适配

**Files:**
- Modify: `web/src/pages/workflow/components/RunStatusPanel.tsx`

- [ ] **Step 1: 移除 setRightTab prop**

在 `RunStatusPanelProps` 接口中，删除：
```ts
setRightTab: (tab: "config" | "run" | "versions") => void;
```

在 `RunStatusPanel` 函数的解构参数中，删除 `setRightTab`。

- [ ] **Step 2: 替换 setRightTab 调用**

将 `RunListPanel` 的 `onClose` 从：
```ts
onClose={() => setRightTab("config")}
```
改为：
```ts
onClose={handleBackToList}
```

注意：`handleBackToList` 已经在 props 中。

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/workflow/components/RunStatusPanel.tsx
git commit -m "refactor(workflow): remove setRightTab from RunStatusPanel props"
```

---

### Task 11: 重构 WorkflowEditor.tsx — 核心改造

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

这是最大的改造任务。以下按步骤描述变更。

- [ ] **Step 1: 更新 import**

添加 import：
```ts
import { Settings } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { NodeConfigPopover } from "./components/NodeConfigPopover";
import { WorkflowMetaPopover } from "./components/WorkflowMetaPopover";
```

删除不再需要的 import（`NodeConfigPanel`）：
```ts
// 删除: import { NodeConfigPanel } from "./components/NodeConfigPanel";
```

添加 `Settings` 图标（如果还没导入）。

- [ ] **Step 2: 替换 rightTab 状态**

删除：
```ts
const [rightTab, setRightTab] = useState<"config" | "run" | "versions" | "triggers">("config");
```

替换为三个布尔状态：
```ts
const [runSheetOpen, setRunSheetOpen] = useState(false);
const [versionsSheetOpen, setVersionsSheetOpen] = useState(false);
const [triggersSheetOpen, setTriggersSheetOpen] = useState(false);
```

- [ ] **Step 3: 添加 popover 状态**

添加节点配置 popover 状态：
```ts
const [popoverOpen, setPopoverOpen] = useState(false);
const [metaPopoverOpen, setMetaPopoverOpen] = useState(false);
```

- [ ] **Step 4: 修改 onNodeClick 行为**

在 `useWorkflowCanvas` 的 `onSelectionChange` 回调之外，添加一个 `onNodeClick` 处理。当前 `onSelectionChange` 会设置 `selectedNode`。需要修改为：点击节点时先关闭 popover，设置 selectedNode 但不立即打开 popover。

在 `WorkflowEditorInner` 中添加 `onNodeClick` 回调：

```ts
const handleNodeClick = useCallback(
  (_event: React.MouseEvent, node: Node) => {
    if (popoverOpen) {
      setPopoverOpen(false);
      setSelectedNode(null);
    } else {
      setSelectedNode(node);
      setPopoverOpen(true);
    }
  },
  [popoverOpen],
);
```

将 `handleNodeClick` 传给 ReactFlow 的 `onNodeClick` prop：
```tsx
<ReactFlow
  ...
  onNodeClick={handleNodeClick}
  ...
>
```

- [ ] **Step 5: 添加画布拖拽关闭 popover**

在 `useWorkflowCanvas` 调用的返回值中，`onMoveStart` 时关闭 popover。添加 effect：

```ts
const handleMoveStart = useCallback(() => {
  if (popoverOpen) {
    setPopoverOpen(false);
    setSelectedNode(null);
  }
}, [popoverOpen]);
```

将 `handleMoveStart` 传给 ReactFlow 的 `onMoveStart` prop。

- [ ] **Step 6: 节点删除时关闭 popover**

在 `handleNodesDelete` 回调中，添加 popover 关闭逻辑。找到现有的 `handleNodesDelete` 调用处，在其执行后检查被删除的节点是否是当前选中节点。

在 `onNodesDelete` 被调用的位置，添加：
```ts
const wrappedHandleNodesDelete = useCallback(
  (deleted: Node[]) => {
    handleNodesDelete(deleted);
    if (selectedNode && deleted.some((n) => n.id === selectedNode.id)) {
      setPopoverOpen(false);
      setSelectedNode(null);
    }
  },
  [handleNodesDelete, selectedNode],
);
```

在 ReactFlow 的 `onNodesDelete` 中使用 `wrappedHandleNodesDelete` 替代 `handleNodesDelete`。

- [ ] **Step 7: 修改 useWorkflowRun 调用参数**

将传给 `useWorkflowRun` 的参数中：
```ts
rightTab,
setRightTab,
```

替换为：
```ts
openRunSheet: () => {
  setRunSheetOpen(true);
  setVersionsSheetOpen(false);
  setTriggersSheetOpen(false);
},
```

- [ ] **Step 8: 修改工具栏按钮行为**

找到工具栏中的版本按钮（Rocket 图标），将：
```tsx
onClick={() => setRightTab(rightTab === "versions" ? "config" : "versions")}
```
改为：
```tsx
onClick={() => {
  setVersionsSheetOpen(!versionsSheetOpen);
  if (!versionsSheetOpen) {
    setRunSheetOpen(false);
    setTriggersSheetOpen(false);
  }
}}
```

将 `rightTab === "versions" ? "active" : ""` 改为 `versionsSheetOpen ? "active" : ""`。

类似地修改触发器按钮（Link 图标）：
```tsx
onClick={() => {
  setTriggersSheetOpen(!triggersSheetOpen);
  if (!triggersSheetOpen) {
    setRunSheetOpen(false);
    setVersionsSheetOpen(false);
  }
}}
```

运行历史按钮（List 图标）：
```tsx
onClick={() => {
  setRunSheetOpen(!runSheetOpen);
  if (!runSheetOpen) {
    setVersionsSheetOpen(false);
    setTriggersSheetOpen(false);
  }
}}
```

每个按钮的 active class 相应改为 `runSheetOpen ? "active" : ""` / `versionsSheetOpen ? "active" : ""` / `triggersSheetOpen ? "active" : ""`。

- [ ] **Step 9: 删除右侧侧边栏 JSX**

删除整个 `<aside className="wf-prop-panel" ...>` 到 `</aside>` 的 JSX 块（约第 684-775 行），包括其中的 tab 头、config tab、run tab、versions tab、triggers tab 内容。

替换为 Popover 和 Sheet 组件。

- [ ] **Step 10: 添加 NodeConfigPopover 和 WorkflowMetaPopover JSX**

在 `<div className="wf-canvas-wrapper">` 内部末尾、`YamlSlidePanel` 之后添加：

```tsx
{/* 节点配置 Popover */}
<NodeConfigPopover
  open={popoverOpen}
  onOpenChange={(open) => {
    setPopoverOpen(open);
    if (!open) setSelectedNode(null);
  }}
  selectedNode={selectedNode}
  sd={sd}
  nodeType={nodeType}
  readOnly={readOnly}
  handleIdChange={handleIdChange}
  setNodes={setNodes}
  setSelectedNode={setSelectedNode}
  updateNodeData={updateNodeData}
  agentList={agentList}
  meta={meta}
  updateMeta={updateMeta}
/>

{/* 工作流元数据 Popover（右下角锚点） */}
<WorkflowMetaPopover
  open={metaPopoverOpen}
  onOpenChange={setMetaPopoverOpen}
  readOnly={readOnly}
  meta={meta}
  updateMeta={updateMeta}
/>
```

- [ ] **Step 11: 添加 Run Sheet JSX**

在 `</div>` (wf-canvas-wrapper 结束) 之后、MetaAgentPanel 之前添加三个 Sheet：

```tsx
{/* 运行状态 Sheet */}
<Sheet open={runSheetOpen} onOpenChange={setRunSheetOpen}>
  <SheetContent side="right" className="wf-sheet" style={{ width: 360, maxWidth: 360 }}>
    <SheetHeader>
      <SheetTitle>{t("editor.run_history")}</SheetTitle>
    </SheetHeader>
    <div className="wf-sheet-body">
      <RunStatusPanel
        activeRunId={activeRunId}
        runSnapshot={runSnapshot}
        dagStatus={dagStatus}
        isRunMode={isRunMode}
        isRunDone={isRunDone}
        running={running}
        runEvents={runEvents}
        runApprovals={runApprovals}
        runRightTab={runRightTab}
        setRunRightTab={setRunRightTab}
        selectedRunNodeId={selectedRunNodeId}
        setSelectedRunNodeId={setSelectedRunNodeId}
        selectedNodeOutput={selectedNodeOutput}
        nodeOutputLoading={nodeOutputLoading}
        handleCancelRun={handleCancelRun}
        handleBackToEdit={() => {
          handleBackToEdit();
          setRunSheetOpen(false);
        }}
        handleBackToList={() => {
          handleBackToList();
          setRunSheetOpen(false);
        }}
        handleApprove={handleApprove}
        handleRerunFrom={handleRerunFrom}
        setActiveRunId={setActiveRunId}
        setRunSnapshot={setRunSnapshot}
        setRunEvents={setRunEvents}
        setRunApprovals={setRunApprovals}
        setSelectedNodeOutput={setSelectedNodeOutput}
        updateNodesFromSnapshot={updateNodesFromSnapshot}
      />
    </div>
  </SheetContent>
</Sheet>

{/* 版本管理 Sheet */}
<Sheet open={versionsSheetOpen} onOpenChange={setVersionsSheetOpen}>
  <SheetContent side="right" className="wf-sheet" style={{ width: 360, maxWidth: 360 }}>
    <SheetHeader>
      <SheetTitle>{t("editor.version_management")}</SheetTitle>
    </SheetHeader>
    <div className="wf-sheet-body">
      <VersionPanel
        workflowId={workflowId}
        onClose={() => setVersionsSheetOpen(false)}
        onPublish={handlePublish}
        publishing={publishing}
      />
    </div>
  </SheetContent>
</Sheet>

{/* 触发器 Sheet */}
<Sheet open={triggersSheetOpen} onOpenChange={setTriggersSheetOpen}>
  <SheetContent side="right" className="wf-sheet" style={{ width: 360, maxWidth: 360 }}>
    <SheetHeader>
      <SheetTitle>{t("editor.trigger_title")}</SheetTitle>
    </SheetHeader>
    <div className="wf-sheet-body">
      <TriggerPanel
        workflowId={workflowId}
        onClose={() => setTriggersSheetOpen(false)}
      />
    </div>
  </SheetContent>
</Sheet>
```

- [ ] **Step 12: 修改 readonly badge 位置**

找到 readonly badge 的样式 `right: 300px`，改为 `right: 12px`。

- [ ] **Step 13: 修改历史 run 数据加载中的 setRightTab**

找到加载历史 run 的 useEffect 中：
```ts
setRightTab("run");
```
改为：
```ts
setRunSheetOpen(true);
```

- [ ] **Step 14: 验证构建**

Run: `bun run build:web`
Expected: 构建成功

- [ ] **Step 15: Commit**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat(workflow): replace sidebar with popover cards and sheets"
```

---

### Task 12: 清理旧 CSS 和废弃代码

**Files:**
- Modify: `web/src/pages/workflow/workflow.css`
- Modify: `web/src/pages/workflow/components/NodeConfigPanel.tsx`

- [ ] **Step 1: 删除旧侧边栏 CSS**

在 `web/src/pages/workflow/workflow.css` 中删除以下不再使用的样式块：

- `.wf-prop-panel` 及其相关样式（第 22-29 行区域）
- `.wf-readonly-badge` 中的 `right: 300px` 引用已在 Task 11 中修改
- `.wf-run-panel` 样式（如果不再使用）

同时添加 Sheet 相关的样式：

```css
/* ── Workflow Sheet ── */
.wf-sheet {
  padding: 0;
}

.wf-sheet-body {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 2: 标记 NodeConfigPanel 为废弃**

在 `web/src/pages/workflow/components/NodeConfigPanel.tsx` 文件顶部添加注释：

```ts
/**
 * @deprecated 使用 NodeConfigCard + NodeConfigPopover 或 WorkflowMetaCard + WorkflowMetaPopover 替代
 */
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/workflow/workflow.css web/src/pages/workflow/components/NodeConfigPanel.tsx
git commit -m "refactor(workflow): clean up old sidebar CSS and deprecate NodeConfigPanel"
```

---

### Task 13: 构建验证和 precheck

**Files:** 无文件变更

- [ ] **Step 1: 运行前端构建**

Run: `bun run build:web`
Expected: 构建成功，无 TypeScript 错误

- [ ] **Step 2: 运行 precheck**

Run: `bun run precheck`
Expected: 格式化、import 排序、类型检查、lint 全部通过

- [ ] **Step 3: 手动功能验证清单**

启动 `bun run dev` + `bun run dev:web`，在浏览器中验证：

1. 点击节点 → 右侧弹出 popover 卡片，显示节点配置
2. 点击画布空白 → popover 关闭
3. 点击另一个节点 → popover 关闭（不立即打开新的）
4. 再次点击节点 → popover 打开
5. 拖拽画布 → popover 关闭
6. 删除节点 → 如果 popover 打开则关闭
7. 右下角齿轮按钮 → 点击弹出工作流元数据 popover
8. 工具栏版本按钮 → Sheet 从右侧滑出
9. 工具栏触发器按钮 → Sheet 从右侧滑出
10. 工具栏运行历史按钮 → Sheet 从右侧滑出
11. 同一时间只有一个 Sheet 打开
12. Readonly 模式下 popover 可查看但字段禁用
13. Readonly badge 位置正确（右边缘）
14. 节点靠近右边缘时 popover 自动翻转到左侧

- [ ] **Step 4: 最终 commit（如有 precheck 自动修复）**

```bash
git add -A
git commit -m "style(workflow): fix formatting from precheck"
```

---

## Self-Review

### Spec Coverage

| Spec 章节 | 对应 Task |
|-----------|-----------|
| 节点配置 Popover 触发与定位 | Task 5 (组件), Task 11 (编排) |
| 节点配置 Popover 开闭行为 | Task 11 Step 4-6 |
| 节点配置 Popover 尺寸 | Task 8 (CSS) |
| 节点配置 Popover 样式 | Task 8 (CSS) |
| 工作流元数据 Popover | Task 6 (组件), Task 11 (编排) |
| Run/Versions/Triggers Sheet | Task 11 Step 11 |
| 状态管理变化 | Task 11 Step 2-3 |
| 组件拆分 | Task 2-4, Task 5-6 |
| 画布缩放/拖拽关闭 | Task 11 Step 5 |
| Readonly 模式 | Task 11 Step 12 |
| 节点删除关闭 | Task 11 Step 6 |
| data-node-id | Task 1 |

### Placeholder Scan

无 TBD/TODO/placeholder。所有步骤包含具体代码或命令。

### Type Consistency

- `NodeConfigPopoverProps` 与 `NodeConfigCardProps` 的重复 props 保持一致（readOnly, selectedNode, sd, nodeType, handleIdChange, setNodes, setSelectedNode, updateNodeData, agentList）
- `openRunSheet: () => void` 签名在 useWorkflowRun 的参数和调用点一致
- `RunStatusPanelProps` 中删除了 `setRightTab`，对应 Task 10 中同步修改
