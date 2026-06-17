# Meta Agent 上下文感知方案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Meta Agent 在 Workflow 编辑器中感知实时上下文（选中节点变化通过 Context Queue 注入）+ 切换工作流时自动开启新会话。

**Architecture:** 沿 MetaAgentPanel → ChatPanel → ACPMain → ChatInterface 逐层新增 `contextKey` prop，ChatInterface 检测 `contextKey` 变化时调用 `handleNewSession()`。WorkflowEditor 通过 `useContextQueue("workflow-editor-context")` 将选中节点信息注入每次消息，并传入 `workflowId` 作为 contextKey。

**Tech Stack:** React 19 + TypeScript + happy-dom (测试) + react-i18next + shadcn/ui

---

### Task 1: ChatInterface — 接受 contextKey prop，变化时自动新会话

**Files:**
- Modify: `web/components/ChatInterface.tsx:75-84` (ChatInterfaceProps 接口)
- Modify: `web/components/ChatInterface.tsx:278-281` (组件函数签名)
- Modify: `web/components/ChatInterface.tsx:291` (新增 contextKey 变化检测)

- [ ] **Step 1: 在 ChatInterfaceProps 中添加 contextKey 字段**

在 `web/components/ChatInterface.tsx` 第 82 行 `scenePrompt?: string` 之后添加：

```typescript
  scenePrompt?: string;
  /** 上下文标识：变化时自动触发 newSession（如工作流 ID 变化） */
  contextKey?: string;
  onPromptComplete?: () => void;
```

- [ ] **Step 2: 在组件解构中接收 contextKey**

在第 279 行解构中添加 `contextKey`：

```typescript
  { client, agentId, readonly, hideContextPanel, rcsSessionId, onSessionCreated, scenePrompt, contextKey, onPromptComplete },
```

- [ ] **Step 3: 添加 contextKey 变化 → handleNewSession 的 useEffect**

在第 291 行 `const scenePromptUsedRef = useRef(false);` 之后添加：

```typescript
  const scenePromptUsedRef = useRef(false);
  // 当 contextKey 变化时自动开始新会话（仅在 contextKey 有值且发生变化时触发）
  const contextKeyRef = useRef(contextKey);
  useEffect(() => {
    if (contextKey !== undefined && contextKeyRef.current !== undefined && contextKeyRef.current !== contextKey) {
      handleNewSession();
    }
    contextKeyRef.current = contextKey;
  }, [contextKey, handleNewSession]);
```

**注意：** React 的 `useEffect` 依赖 `handleNewSession` 可能在 `isLoading` 变化时触发额外执行，但 `contextKeyRef` 的初始值检查确保只在 `contextKey` 真正变化时才调 `handleNewSession`。

- [ ] **Step 4: 运行 tsc 验证类型**

Run: `cd web && tsc --noEmit`
Expected: PASS (无新增类型错误)

- [ ] **Step 5: Commit**

```bash
git add web/components/ChatInterface.tsx
git commit -m "feat(chat): ChatInterface 支持 contextKey prop 变化自动新会话

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 2: ACPMain — 透传 contextKey prop

**Files:**
- Modify: `web/components/ACPMain.tsx:14-23` (ACPMainProps 接口)
- Modify: `web/components/ACPMain.tsx:29-37` (组件函数签名)
- Modify: `web/components/ACPMain.tsx:192-202` (ChatInterface 调用处)

- [ ] **Step 1: 在 ACPMainProps 中添加 contextKey 字段**

在第 21 行 `scenePrompt?: string` 之后添加：

```typescript
  scenePrompt?: string;
  contextKey?: string;
  onPromptComplete?: () => void;
```

- [ ] **Step 2: 在组件解构中接收 contextKey**

在第 35 行 `scenePrompt` 之后添加 `contextKey`：

```typescript
  scenePrompt,
  contextKey,
  onPromptComplete,
}: ACPMainProps) {
```

- [ ] **Step 3: 在 ChatInterface 调用处传入 contextKey**

在第 199 行 `scenePrompt={scenePrompt}` 之后添加：

```tsx
            scenePrompt={scenePrompt}
            contextKey={contextKey}
            onSessionCreated={(sessionId) => setInitialActiveSessionId(sessionId)}
```

- [ ] **Step 4: 运行 tsc 验证**

Run: `cd web && tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/components/ACPMain.tsx
git commit -m "feat(chat): ACPMain 透传 contextKey prop

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 3: ChatPanel — 透传 contextKey prop

**Files:**
- Modify: `web/src/pages/agent-panel/ChatPanel.tsx:12-20` (ChatPanelProps 接口)
- Modify: `web/src/pages/agent-panel/ChatPanel.tsx:22-30` (组件函数签名)
- Modify: `web/src/pages/agent-panel/ChatPanel.tsx:153-161` (ACPMain 调用处)

- [ ] **Step 1: 在 ChatPanelProps 中添加 contextKey 字段**

在第 18 行 `scenePrompt?: string` 之后添加：

```typescript
  scenePrompt?: string;
  contextKey?: string;
  onPromptComplete?: () => void;
```

- [ ] **Step 2: 在组件解构中接收 contextKey**

在第 28 行 `scenePrompt` 之后添加 `contextKey`：

```typescript
  scenePrompt,
  contextKey,
  onPromptComplete,
}: ChatPanelProps) {
```

- [ ] **Step 3: 在 ACPMain 调用处传入 contextKey**

在第 159 行 `scenePrompt={scenePrompt}` 之后添加：

```tsx
          scenePrompt={scenePrompt}
          contextKey={contextKey}
          onPromptComplete={onPromptComplete}
```

- [ ] **Step 4: 运行 tsc 验证**

Run: `cd web && tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/agent-panel/ChatPanel.tsx
git commit -m "feat(chat): ChatPanel 透传 contextKey prop

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 4: MetaAgentPanel — 透传 contextKey prop

**Files:**
- Modify: `web/components/MetaAgentPanel.tsx:6-17` (MetaAgentPanelProps 接口)
- Modify: `web/components/MetaAgentPanel.tsx:27-33` (组件函数签名)
- Modify: `web/components/MetaAgentPanel.tsx:68-73` (ChatPanel 调用处)

- [ ] **Step 1: 在 MetaAgentPanelProps 中添加 contextKey 字段**

在第 14 行 `scenePrompt?: string` 之后添加：

```typescript
  scenePrompt?: string;
  /** 上下文标识：变化时自动触发新会话 */
  contextKey?: string;
  /** 会话完成后的回调 */
  onPromptComplete?: () => void;
```

- [ ] **Step 2: 在组件解构中接收 contextKey**

在第 31 行 `scenePrompt` 之后添加 `contextKey`：

```typescript
  scenePrompt,
  contextKey,
  onPromptComplete,
}: MetaAgentPanelProps) {
```

- [ ] **Step 3: 在 ChatPanel 调用处传入 contextKey**

在第 71 行 `scenePrompt={scenePrompt}` 之后添加：

```tsx
              scenePrompt={scenePrompt}
              contextKey={contextKey}
              onPromptComplete={onPromptComplete}
```

- [ ] **Step 4: 运行 tsc 验证**

Run: `cd web && tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/components/MetaAgentPanel.tsx
git commit -m "feat(chat): MetaAgentPanel 透传 contextKey prop

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 5: useWorkflowMetaAgent — 新增 contextKey + editorContext

**Files:**
- Modify: `web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts:7-20` (接口定义)
- Modify: `web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts:26-70` (hook 实现)

- [ ] **Step 1: 扩展 UseWorkflowMetaAgentParams 接口**

在第 9 行 `meta: WfMeta` 之后添加 `selectedNodeInfo`：

```typescript
export interface UseWorkflowMetaAgentParams {
  workflowId: string | undefined;
  meta: WfMeta;
  /** 当前选中的节点信息（id + type），用于 context queue */
  selectedNodeInfo?: { id: string; type: string } | null;
}
```

- [ ] **Step 2: 扩展 UseWorkflowMetaAgentReturn 接口**

在第 19 行 `setAgentOverrideOpen` 之后添加 `contextKey`：

```typescript
  setAgentOverrideOpen: (open: boolean) => void;
  /** 上下文标识（workflowId），变化时触发新会话 */
  contextKey: string | undefined;
}
```

- [ ] **Step 3: 在 hook 实现中计算 contextKey 和 editorContext**

替换 `return` 之前的代码，在 `agentList` 的 `useEffect` 之后添加：

```typescript
  // contextKey 取 workflowId：变化时 ChatInterface 自动开新会话
  const contextKey = workflowId;
```

并在 `return` 对象中添加 `contextKey`：

```typescript
  return {
    scenePrompt,
    contextKey,
    chatOpen,
    setChatOpen,
    metaAgentId,
    agentList,
    agentOverrideOpen,
    setAgentOverrideOpen,
  };
```

- [ ] **Step 4: 运行 tsc 验证**

Run: `cd web && tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts
git commit -m "feat(meta-agent): useWorkflowMetaAgent 新增 contextKey 和 selectedNodeInfo 参数

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 6: WorkflowEditor — 接入 useContextQueue + 传入 contextKey + 选中节点上下文

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx:129` (useWorkflowMetaAgent 调用处)
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx:896-901` (MetaAgentPanel 调用处)
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx` (新增 import + useContextQueue 调用)

- [ ] **Step 1: 添加 import**

在文件顶部的 import 区域，添加：

```typescript
import { useContextQueue } from "@/src/lib/use-context-queue";
import { useMemo } from "react";  // 如果尚不存在
```

**注意：** `useContextQueue` 路径为 `@/src/lib/use-context-queue`。验证 `useMemo` 已被 import。

- [ ] **Step 2: 计算 editorContext 字符串并生成 contextKey**

在第 129 行 `useWorkflowMetaAgent` 调用处，添加 `selectedNodeInfo` 参数和接收 `contextKey`：

```typescript
  const selectedNodeInfo = useMemo(() => {
    if (!selectedNode) return null;
    return { id: selectedNode.id, type: selectedNode.type ?? "unknown" };
  }, [selectedNode?.id, selectedNode?.type]);

  const { scenePrompt, contextKey, chatOpen, setChatOpen, metaAgentId, agentList } = useWorkflowMetaAgent({
    workflowId,
    meta,
    selectedNodeInfo,
  });
```

- [ ] **Step 3: 调用 useContextQueue 将选中节点信息推入 context queue**

在 `useWorkflowMetaAgent` 调用之后，添加：

```typescript
  // 将当前编辑器上下文推入 Context Queue，每次消息发送时 agent 可感知
  const editorContextText = useMemo(() => {
    const lines: string[] = ["[Workflow Editor Context]"];
    lines.push(`- ${t("editor.workflow_name")}: ${meta.name || t("editor.workflow_unnamed")}`);
    if (selectedNodeInfo) {
      lines.push(`- ${t("editor.selected_node")}: ${selectedNodeInfo.id} (type: ${selectedNodeInfo.type})`);
    }
    return lines.join("\n");
  }, [meta.name, selectedNodeInfo?.id, selectedNodeInfo?.type, t]);

  useContextQueue("workflow-editor-context", editorContextText);
```

- [ ] **Step 4: 更新 MetaAgentPanel 调用处传入 contextKey**

在第 896-901 行，添加 `contextKey` prop：

```tsx
      <MetaAgentPanel
        chatOpen={chatOpen}
        setChatOpen={setChatOpen}
        metaAgentId={metaAgentId}
        scenePrompt={scenePrompt}
        contextKey={contextKey}
        onPromptComplete={handleRefreshDraft}
      />
```

- [ ] **Step 5: 运行 tsc 验证**

Run: `cd web && tsc --noEmit`
Expected: PASS (需确认 `t("editor.selected_node")` key 存在或新增 i18n)

- [ ] **Step 6: 检查 i18n key**

检查 `web/src/i18n/locales/zh/workflows.json` 中是否已有 `editor.selected_node` key。如果没有，需要新增。

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat(meta-agent): WorkflowEditor 接入 context queue + contextKey

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 7: i18n 补充 + 最终验证

**Files:**
- Modify: `web/src/i18n/locales/zh/workflows.json` (新增 selected_node key)
- Modify: `web/src/i18n/locales/en/workflows.json` (新增 selected_node key)

- [ ] **Step 1: 检查并补充 i18n key**

如果 `editor.selected_node` 不存在，在 `web/src/i18n/locales/zh/workflows.json` 中添加：

```json
    "selected_node": "选中节点",
```

在 `web/src/i18n/locales/en/workflows.json` 中添加：

```json
    "selected_node": "Selected node",
```

- [ ] **Step 2: 运行完整 precheck**

Run: `bun run precheck`
Expected: All steps pass (format / import-sort / tsc / lint / test)

- [ ] **Step 3: 手动测试场景**

1. 打开工作流 A 的编辑器，打开 Meta Agent 面板，确认聊天正常连接
2. 选中一个节点，发送消息 → agent 应收到 `[Workflow Editor Context]` system-reminder
3. 切换到工作流 B → Meta Agent 应自动开启新会话
4. 新会话首条消息应带新的 `scenePrompt`（含工作流 B 信息）+ `[Workflow Editor Context]` system-reminder

- [ ] **Step 4: Commit**

```bash
git add web/src/i18n/locales/zh/workflows.json web/src/i18n/locales/en/workflows.json
git commit -m "feat(meta-agent): 补充 editor.selected_node i18n

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## 架构图

```
WorkflowEditor
  ├─ selectedNode: { id, type } → memo → selectedNodeInfo
  ├─ useWorkflowMetaAgent({ workflowId, meta, selectedNodeInfo })
  │   ├─ contextKey = workflowId
  │   └─ scenePrompt (不变)
  ├─ useContextQueue("workflow-editor-context", editorContextText)
  │   └─ 每次消息注入: [Workflow Editor Context] 工作流信息 + 选中节点
  └─ MetaAgentPanel
      ├─ contextKey={workflowId}
      ├─ scenePrompt={...}
      └─ ChatPanel → ACPMain → ChatInterface
          └─ contextKey 变化 → useEffect → handleNewSession()
```

## 测试要点

| 场景 | 预期行为 |
|------|----------|
| workflowId 不变但选中节点变化 | Context Queue 更新，下次消息含新节点信息 |
| workflowId 变化（从 A → B） | ChatInterface 自动 `handleNewSession()`，新会话首条消息含 B 的 scenePrompt + context |
| 首次打开 Meta Agent | contextKey 首次设置，不触发 newSession（`contextKeyRef.current === undefined` 检查） |
| MetaAgentPanel 未传入 contextKey | ChatInterface 不触发自动 newSession（向后兼容） |
