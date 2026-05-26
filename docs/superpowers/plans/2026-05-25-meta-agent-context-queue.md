# Meta Agent Context Queue 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 v2 Agent 面板实现前端上下文队列，在用户发送消息时自动注入当前 UI 状态到 `<system-reminder>` block 中，前端渲染时隐藏该 block。

**Architecture:** 模块级 Map 存储上下文片段，React hook 封装生命周期管理。发送消息时 flush 队列，拼入 `ContentBlock[]` 的第一个 part。渲染时通过字符串匹配过滤 `<system-reminder>` block。

**Tech Stack:** TypeScript, React 19 (hooks), ACP ContentBlock[], Bun test

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `web/src/lib/context-queue.ts` | 新建 | 模块级 Map + push/remove/flush/isVisibleContentBlock |
| `web/src/lib/use-context-queue.ts` | 新建 | React hook，封装 useEffect 注册/清理 |
| `web/src/__tests__/context-queue.test.ts` | 新建 | 纯函数单元测试 |
| `web/components/ChatInterface.tsx` | 修改 | 发送消息时 flush context queue 并注入 ContentBlock |
| `web/components/chat/MessageBubble.tsx` | 修改 | 用户消息渲染时过滤 system-reminder 内容 |
| `web/src/routes/agent/_panel/chat.$agentId.tsx` | 修改 | 注册路由级上下文（agentId） |
| `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx` | 修改 | 注册路由级上下文（agentId + sessionId） |

---

### Task 1: Context Queue 核心模块 + 测试

**Files:**
- Create: `web/src/lib/context-queue.ts`
- Create: `web/src/__tests__/context-queue.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// web/src/__tests__/context-queue.test.ts
import { describe, expect, test } from "bun:test";

const {
  pushContext,
  removeContext,
  flushContext,
  clearContextQueue,
  isVisibleContentBlock,
} = await import("../lib/context-queue");

// 每个测试前清理，避免测试间污染
describe("context-queue", () => {
  test("flushContext 返回 null 当队列为空", () => {
    clearContextQueue();
    expect(flushContext()).toBeNull();
  });

  test("pushContext + flushContext 返回拼接的 system-reminder block", () => {
    clearContextQueue();
    pushContext("route", "当前页面: /agent/chat/agent-123");
    pushContext("session", "sessionId: ses-456");
    const result = flushContext();
    expect(result).not.toBeNull();
    expect(result!.startsWith("<system-reminder>")).toBe(true);
    expect(result!.endsWith("</system-reminder>")).toBe(true);
    expect(result).toContain("当前页面: /agent/chat/agent-123");
    expect(result).toContain("sessionId: ses-456");
  });

  test("flushContext 清空队列后再次 flush 返回 null", () => {
    clearContextQueue();
    pushContext("route", "test");
    flushContext();
    expect(flushContext()).toBeNull();
  });

  test("pushContext 覆盖同 key 的旧值", () => {
    clearContextQueue();
    pushContext("route", "旧页面");
    pushContext("route", "新页面");
    const result = flushContext();
    expect(result).toContain("新页面");
    expect(result).not.toContain("旧页面");
  });

  test("removeContext 移除指定 key", () => {
    clearContextQueue();
    pushContext("route", "页面");
    pushContext("session", "会话");
    removeContext("session");
    const result = flushContext();
    expect(result).toContain("页面");
    expect(result).not.toContain("会话");
  });

  test("removeContext 不存在的 key 不报错", () => {
    clearContextQueue();
    expect(() => removeContext("nonexistent")).not.toThrow();
  });
});

describe("isVisibleContentBlock", () => {
  test("text block 包含完整 system-reminder 标签时返回 false", () => {
    expect(isVisibleContentBlock({ type: "text", text: "<system-reminder>xxx</system-reminder>" })).toBe(false);
  });

  test("text block 标签前后有空白时返回 false", () => {
    expect(isVisibleContentBlock({ type: "text", text: "  <system-reminder>xxx</system-reminder>  " })).toBe(false);
  });

  test("text block 标签内部有换行时返回 false", () => {
    expect(
      isVisibleContentBlock({ type: "text", text: "<system-reminder>\nline1\nline2\n</system-reminder>" }),
    ).toBe(false);
  });

  test("普通文本 text block 返回 true", () => {
    expect(isVisibleContentBlock({ type: "text", text: "hello" })).toBe(true);
  });

  test("文本中包含但不完整包裹 system-reminder 时返回 true", () => {
    expect(isVisibleContentBlock({ type: "text", text: "这里提到了 <system-reminder> 但不是完整包裹" })).toBe(true);
  });

  test("只有开始标签没有结束标签时返回 true", () => {
    expect(isVisibleContentBlock({ type: "text", text: "<system-reminder>some content" })).toBe(true);
  });

  test("非 text 类型 block 返回 true", () => {
    expect(isVisibleContentBlock({ type: "image", mimeType: "image/png", data: "base64..." })).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test web/src/__tests__/context-queue.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现核心模块**

```typescript
// web/src/lib/context-queue.ts

const contextQueue = new Map<string, string>();

export function pushContext(key: string, text: string): void {
  contextQueue.set(key, text);
}

export function removeContext(key: string): void {
  contextQueue.delete(key);
}

export function flushContext(): string | null {
  if (contextQueue.size === 0) return null;
  const parts = Array.from(contextQueue.values());
  contextQueue.clear();
  return `<system-reminder>\n${parts.join("\n")}\n</system-reminder>`;
}

export function clearContextQueue(): void {
  contextQueue.clear();
}

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

export function isVisibleContentBlock(block: { type: string; text?: string }): boolean {
  if (block.type !== "text" || !block.text) return true;
  const trimmed = block.text.trim();
  return !(trimmed.startsWith(SYSTEM_REMINDER_OPEN) && trimmed.endsWith(SYSTEM_REMINDER_CLOSE));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test web/src/__tests__/context-queue.test.ts`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/context-queue.ts web/src/__tests__/context-queue.test.ts
git commit -m "feat: 添加 context-queue 模块及单元测试"
```

---

### Task 2: React Hook 封装

**Files:**
- Create: `web/src/lib/use-context-queue.ts`

- [ ] **Step 1: 实现 hook**

```typescript
// web/src/lib/use-context-queue.ts
import { useEffect, useRef } from "react";
import { pushContext, removeContext } from "./context-queue";

export function useContextQueue(key: string, text: string | (() => string)): void {
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    const resolvedText = typeof text === "function" ? text() : text;
    pushContext(keyRef.current, resolvedText);

    return () => {
      removeContext(keyRef.current);
    };
  }, [key, typeof text === "function" ? undefined : text]);
}
```

注意：当 `text` 是函数时，不作为依赖项（避免闭包陷阱），只在 mount/unmount 时执行。当 `text` 是字符串时，变化时自动更新。

- [ ] **Step 2: 提交**

```bash
git add web/src/lib/use-context-queue.ts
git commit -m "feat: 添加 useContextQueue React hook"
```

---

### Task 3: 消息发送集成 — 注入 context block

**Files:**
- Modify: `web/components/ChatInterface.tsx:757-844`（`handleChatInputSubmit` 函数）

- [ ] **Step 1: 添加 import**

在 `web/components/ChatInterface.tsx` 顶部的 import 区域添加：

```typescript
import { flushContext } from "../src/lib/context-queue";
```

注意路径：`ChatInterface.tsx` 在 `web/components/` 下，所以相对路径是 `../src/lib/context-queue`。

- [ ] **Step 2: 在 `handleChatInputSubmit` 中注入 context block**

找到 `handleChatInputSubmit` 函数（约第 757 行），在 `scenePrompt` 注入之后、`client.sendPrompt` 之前，添加 context queue flush 逻辑。

修改位置在第 826 行（`scenePrompt` 块结束）之后，第 839 行（`client.sendPrompt`）之前：

```typescript
      // 注入场景提示词（仅第一条消息，隐藏不显示）
      if (scenePrompt && !scenePromptUsedRef.current) {
        contentBlocks.unshift({ type: "text", text: scenePrompt });
        scenePromptUsedRef.current = true;
      }

      // 注入上下文队列（flush 后清空）
      const contextBlock = flushContext();
      if (contextBlock) {
        contentBlocks.unshift({ type: "text", text: contextBlock });
      }

      // Add user message entry
```

这确保 `<system-reminder>` block 在 `contentBlocks` 数组最前面，在 `scenePrompt` 之前。

- [ ] **Step 3: 验证编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web`
Expected: 编译成功，无类型错误

- [ ] **Step 4: 提交**

```bash
git add web/components/ChatInterface.tsx
git commit -m "feat: ChatInterface 发送消息时注入 context queue"
```

---

### Task 4: 前端渲染隐藏 — 过滤 system-reminder block

**Files:**
- Modify: `web/components/chat/MessageBubble.tsx`

当前 `UserBubble` 组件直接渲染 `entry.content`（纯文本字符串）。context queue 的 `<system-reminder>` block 虽然作为独立 `ContentBlock` 发送，但用户消息回显使用的是 `UserMessageEntry.content` 字段（仅包含用户输入文本，不包含 system-reminder block），所以用户消息回显本身不需要过滤。

真正需要过滤的是 **assistant 回复**中可能原样引用的 system-reminder 内容，以及未来如果 `UserMessageEntry` 格式变更的情况。

但根据当前代码分析：
- `UserMessageEntry.content` 只存储用户输入的 `text`，不包含 system-reminder block（第 829-833 行，只取 `text` 变量）
- Assistant 回复通过 `session_update` 事件到达，内容由 agent 决定

因此，**当前的实现已经天然地不会在用户消息回显中显示 system-reminder**（因为 `entry.content` 只包含用户文本）。

但为了防御性和未来扩展，我们仍然在 `AssistantBubble` 的 chunk 渲染中添加过滤。

- [ ] **Step 1: 添加 import 并在 AssistantBubble 中过滤 system-reminder chunk**

在 `web/components/chat/MessageBubble.tsx` 顶部添加 import：

```typescript
import { isVisibleContentBlock } from "../../src/lib/context-queue";
```

在 `AssistantBubble` 组件中，找到渲染 chunks 的 map 逻辑（约第 120 行），在 map 内部添加过滤：

```typescript
export function AssistantBubble({ entry, isStreaming, envId }: AssistantBubbleProps) {
  return (
    <div className="flex gap-4 items-start">
      <AgentAvatar className="hidden md:flex mt-0.5" />
      <div className="flex-1 min-w-0 space-y-4">
        {entry.chunks
          .filter((chunk) => {
            if (chunk.type === "thought") return true;
            return isVisibleContentBlock({ type: "text", text: chunk.text });
          })
          .map((chunk, i) => {
            if (chunk.type === "thought") {
              return <Reasoning key={i}>{chunk.text}</Reasoning>;
            }
            return (
              <div key={i} className="message-content text-text-primary">
                <MessageResponse envId={envId}>{chunk.text}</MessageResponse>
              </div>
            );
          })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 验证编译通过**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 3: 提交**

```bash
git add web/components/chat/MessageBubble.tsx
git commit -m "feat: AssistantBubble 过滤 system-reminder 内容 block"
```

---

### Task 5: 注册路由级上下文

**Files:**
- Modify: `web/src/routes/agent/_panel/chat.$agentId.tsx`

- [ ] **Step 1: 添加 import 和 hook 调用**

在 `web/src/routes/agent/_panel/chat.$agentId.tsx` 中添加 import：

```typescript
import { useContextQueue } from "../../../lib/use-context-queue";
```

在 `ChatRoute` 函数组件内部，`const { agentId } = Route.useParams();` 之后添加：

```typescript
  const { agentId } = Route.useParams();
  const { sessionId } = Route.useSearch({ strict: false }) as { sessionId?: string };

  useContextQueue("route", () => {
    const lines = [`当前页面: /agent/chat/${agentId}`, `agentId: ${agentId}`];
    if (sessionId) lines.push(`sessionId: ${sessionId}`);
    return lines.join("\n");
  });
```

注意：这里使用函数形式的 `text` 参数，因为 `agentId` 来自路由参数，在 hook mount 时即可读取。函数形式不作为 useEffect 依赖，避免重复注册。

实际上，`chat.$agentId` 路由中没有 sessionId。`chat.$agentId_.$sessionId` 路由中有。两个路由文件都需要注册上下文。

- [ ] **Step 2: 修改 `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx`**

在文件顶部添加 import：

```typescript
import { useContextQueue } from "../../../../lib/use-context-queue";
```

在 `ChatWithSessionRoute` 函数中，`const { agentId, sessionId } = Route.useParams();` 之后添加：

```typescript
  useContextQueue("route", `当前页面: /agent/chat/${agentId}/${sessionId}\nagentId: ${agentId}\nsessionId: ${sessionId}`);
```

- [ ] **Step 3: 验证编译通过**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 4: 提交**

```bash
git add web/src/routes/agent/_panel/chat.\$agentId.tsx web/src/routes/agent/_panel/chat.\$agentId_.\$sessionId.tsx
git commit -m "feat: 注册路由级上下文到 context queue"
```

---

### Task 6: precheck 和最终验证

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck`
Expected: 通过（format + import sort + tsc + biome check）

- [ ] **Step 2: 运行全部前端测试**

Run: `bun test web/src/__tests__/`
Expected: ALL PASS

- [ ] **Step 3: 运行 context-queue 测试**

Run: `bun test web/src/__tests__/context-queue.test.ts`
Expected: ALL PASS

- [ ] **Step 4: 最终提交（如有 precheck 自动修复）**

```bash
git add -A
git commit -m "chore: precheck 修复"
```
