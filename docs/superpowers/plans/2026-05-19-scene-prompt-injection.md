# Scene Prompt Injection 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WorkflowEditor 嵌入的 meta-agent ChatPanel 在用户发送第一条消息时，自动注入当前工作流的场景上下文提示词，对用户不可见。

**Architecture:** 新增 `scenePrompt?: string` 可选 prop，沿 WorkflowEditor → ChatPanel → ACPMain → ChatInterface 逐层传递。ChatInterface 内部用 `useRef` 标记是否已注入，第一次 `sendPrompt` 时在 `contentBlocks` 头部插入一个独立的 text block，session 切换时重置标记。

**Tech Stack:** React (props drilling), ACPClient.sendPrompt (ContentBlock[])

---

## 文件变更清单

| 文件 | 操作 | 职责 |
|------|------|------|
| `web/components/ChatInterface.tsx` | 修改 | 接收 `scenePrompt` prop，第一次 sendPrompt 时注入，session 切换时重置 |
| `web/components/ACPMain.tsx` | 修改 | 透传 `scenePrompt` prop |
| `web/src/pages/agent-panel/ChatPanel.tsx` | 修改 | 透传 `scenePrompt` prop |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 修改 | 生成 `scenePrompt` 字符串并传入 ChatPanel |

---

### Task 1: ChatInterface — 接收 scenePrompt prop 并在第一条消息注入

**Files:**
- Modify: `web/components/ChatInterface.tsx:62-71` (ChatInterfaceProps 接口)
- Modify: `web/components/ChatInterface.tsx:163` (组件解构)
- Modify: `web/components/ChatInterface.tsx:722-802` (handleChatInputSubmit)

- [ ] **Step 1: 在 ChatInterfaceProps 中添加 scenePrompt 字段**

在 `web/components/ChatInterface.tsx` 的 `ChatInterfaceProps` 接口末尾添加：

```typescript
interface ChatInterfaceProps {
  client: ACPClient;
  agentId?: string;
  cwd?: string;
  cwdReady?: boolean;
  readonly?: boolean;
  hideContextPanel?: boolean;
  rcsSessionId?: string;
  onSessionCreated?: (sessionId: string) => void;
  scenePrompt?: string;
}
```

- [ ] **Step 2: 在组件解构中接收 scenePrompt**

在 `web/components/ChatInterface.tsx` 第 163 行的组件函数签名中添加 `scenePrompt`：

```typescript
export const ChatInterface = forwardRef<ChatInterfaceHandle, ChatInterfaceProps>(function ChatInterface({ client, agentId, cwd, cwdReady = true, readonly, hideContextPanel, rcsSessionId, onSessionCreated, scenePrompt }, ref) {
```

- [ ] **Step 3: 添加 scenePromptUsed ref + session 切换重置逻辑**

在 `activeSessionIdRef` 声明之后（约第 170 行）添加：

```typescript
const activeSessionIdRef = useRef<string | null>(null);
const scenePromptUsedRef = useRef(false);
```

在 `activeSessionIdRef` 的 useEffect（约第 178-180 行）中同步重置：

```typescript
useEffect(() => {
  activeSessionIdRef.current = activeSessionId;
  scenePromptUsedRef.current = false;
}, [activeSessionId]);
```

- [ ] **Step 4: 在 handleChatInputSubmit 中注入 scenePrompt**

修改 `web/components/ChatInterface.tsx` 中 `handleChatInputSubmit` 函数（约第 722 行起）。

在 `if (contentBlocks.length === 0) return;` 这行**之后**、`// Add user message entry` 这行**之前**，插入 scenePrompt 注入逻辑：

```typescript
    if (contentBlocks.length === 0) return;

    // 注入场景提示词（仅第一条消息，隐藏不显示）
    if (scenePrompt && !scenePromptUsedRef.current) {
      contentBlocks.unshift({ type: "text", text: scenePrompt });
      scenePromptUsedRef.current = true;
    }

    // Add user message entry
```

- [ ] **Step 5: 更新 handleChatInputSubmit 的依赖数组**

`handleChatInputSubmit` 的 `useCallback` 依赖数组需要添加 `scenePrompt`：

```typescript
}, [isLoading, sessionReady, client, scenePrompt]);
```

---

### Task 2: ACPMain — 透传 scenePrompt prop

**Files:**
- Modify: `web/components/ACPMain.tsx:11-18` (ACPMainProps 接口)
- Modify: `web/components/ACPMain.tsx:24` (组件解构)
- Modify: `web/components/ACPMain.tsx:239` (ChatInterface 调用处)

- [ ] **Step 1: 在 ACPMainProps 中添加 scenePrompt 字段**

```typescript
interface ACPMainProps {
  client: ACPClient;
  agentId?: string;
  initialCwd?: string;
  readonly?: boolean;
  hideSidebar?: boolean;
  rcsSessionId?: string;
  scenePrompt?: string;
}
```

- [ ] **Step 2: 在组件解构中接收 scenePrompt**

```typescript
export function ACPMain({ client, agentId, initialCwd, readonly, hideSidebar, rcsSessionId, scenePrompt }: ACPMainProps) {
```

- [ ] **Step 3: 在 ChatInterface 调用处传入 scenePrompt**

找到第 239 行附近的 `<ChatInterface ... />` 调用，在 props 中添加 `scenePrompt`：

```typescript
<ChatInterface ref={chatRef} client={client} agentId={agentId} cwd={cwd} cwdReady={cwdReady} readonly={readonly} hideContextPanel={hideSidebar} rcsSessionId={rcsSessionId} scenePrompt={scenePrompt} onSessionCreated={(sessionId) => setInitialActiveSessionId(sessionId)} />
```

---

### Task 3: ChatPanel — 透传 scenePrompt prop

**Files:**
- Modify: `web/src/pages/agent-panel/ChatPanel.tsx:9-15` (ChatPanelProps 接口)
- Modify: `web/src/pages/agent-panel/ChatPanel.tsx:17` (组件解构)
- Modify: `web/src/pages/agent-panel/ChatPanel.tsx:93` (ACPMain 调用处)

- [ ] **Step 1: 在 ChatPanelProps 中添加 scenePrompt 字段**

```typescript
interface ChatPanelProps {
  agentId: string | null;
  sessionId?: string | null;
  initialCwd?: string;
  hideSidebar?: boolean;
  onClientChange?: (client: ACPClient | null) => void;
  scenePrompt?: string;
}
```

- [ ] **Step 2: 在组件解构中接收 scenePrompt**

```typescript
export function ChatPanel({ agentId, sessionId, initialCwd, hideSidebar, onClientChange, scenePrompt }: ChatPanelProps) {
```

- [ ] **Step 3: 在 ACPMain 调用处传入 scenePrompt**

找到第 93 行附近的 `<ACPMain ... />` 调用，添加 `scenePrompt`：

```typescript
<ACPMain client={client} agentId={agentId} initialCwd={initialCwd} hideSidebar={hideSidebar} rcsSessionId={sessionId ?? undefined} scenePrompt={scenePrompt} />
```

---

### Task 4: WorkflowEditor — 生成 scenePrompt 并传入 ChatPanel

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx:128-137` (metaAgentId 状态区域)
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx:1886` (ChatPanel 调用处)

- [ ] **Step 1: 用 useMemo 生成 scenePrompt 字符串**

在 `metaAgentId` 状态声明之后（约第 128 行之后），添加 `scenePrompt` 的计算逻辑。需要使用 `workflowId` 和 `meta`（工作流元数据）来拼接：

```typescript
const scenePrompt = useMemo(() => {
  if (!workflowId) return undefined;
  const lines = [
    "[工作流上下文]",
    `- 工作流 ID: ${workflowId}`,
    `- 名称: ${meta.name || "(未命名)"}`,
    `- 描述: ${meta.description || "(无)"}`,
    `- 草稿路径: .agents/workflows/${workflowId}/draft.yaml`,
    "请先读取草稿文件再响应用户请求。",
  ];
  return lines.join("\n");
}, [workflowId, meta.name, meta.description]);
```

确保文件顶部已导入 `useMemo`（检查现有 import 行是否已包含）。如果没有，在 import 行中添加。

- [ ] **Step 2: 在 ChatPanel 调用处传入 scenePrompt**

找到第 1886 行的 `<ChatPanel agentId={metaAgentId} hideSidebar />` 调用，添加 `scenePrompt`：

```typescript
<ChatPanel agentId={metaAgentId} hideSidebar scenePrompt={scenePrompt} />
```

---

### Task 5: 构建验证

**Files:** 无新文件

- [ ] **Step 1: 运行前端类型检查**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck
```

Expected: 无类型错误

- [ ] **Step 2: 构建前端**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web
```

Expected: 构建成功，无编译错误

- [ ] **Step 3: 运行 Biome lint 检查**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run lint
```

Expected: 无 lint 错误

- [ ] **Step 4: 运行前端测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/
```

Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
git add web/components/ChatInterface.tsx web/components/ACPMain.tsx web/src/pages/agent-panel/ChatPanel.tsx web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat: 工作流场景提示词注入 — 第一条消息自动附带上下文

- ChatInterface 新增 scenePrompt prop，第一次 sendPrompt 时注入独立 text block
- ACPMain / ChatPanel 透传 scenePrompt prop
- WorkflowEditor 根据 workflowId + meta 自动拼接场景上下文
- 使用 useRef 标记注入状态，session 切换时自动重置

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```
