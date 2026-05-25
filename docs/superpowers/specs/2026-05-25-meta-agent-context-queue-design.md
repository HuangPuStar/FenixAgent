# Meta Agent Context Queue 设计

> 日期：2026-05-25
> 状态：已确认，待实现

## 背景

Meta Agent 通过 `agent-platform-api` skill 操作 RCS 平台，但目前缺少前端上下文传递机制。Meta Agent 无法知道用户当前在看什么页面、操作什么资源，导致交互不够智能。

## 目标

设计一个前端上下文队列（Context Queue），在用户发送消息时自动将当前 UI 状态以 `<system-reminder>` block 的形式注入消息中，传递给 Meta Agent。前端渲染时隐藏该 block。

## 设计决策

| 维度 | 决策 | 理由 |
|------|------|------|
| Queue 存储 | 模块级 `Map<string, string>` | 仅发送时读取，无需响应式；零依赖，组件内外均可调用 |
| 上下文类型 | 任意组件可 push 自定义文本 | 灵活可扩展 |
| 首批范围 | 仅路由/页面级别 | 最小可行：当前页面路径、agentId、sessionId 等 |
| 传输方式 | 同一条消息多 part（`ContentBlock[]`） | ACP 协议 `sendPrompt` 已原生支持 `ContentBlock[]`，无需改动协议 |
| 格式 | `<system-reminder>...\n</system-reminder>` 纯文本 | 简单，可读性好 |
| 清理时机 | 每次发送消息时 flush 并清空 | 上下文是瞬时 UI 状态，发送后已过时 |
| 前端隐藏 | 字符串匹配 `<system-reminder>` 标签，整个 part 不渲染 | 简单高效，不需要 XML 解析 |
| 目标范围 | 仅 v2 Agent 面板（WebSocket relay 模式） | Meta Agent 通过 ACP relay 交互 |

## 组件设计

### 1. Context Queue 模块

**文件**：`web/src/lib/context-queue.ts`

模块级 `Map<string, string>` 存储，key 为组件自定义的唯一标识符，value 为上下文文本片段。

暴露三个函数：

- `pushContext(key: string, text: string): void` — 注册或更新某个 key 的上下文片段
- `removeContext(key: string): void` — 移除某个 key 的片段（组件卸载时调用）
- `flushContext(): string | null` — 读取所有片段，拼接为 `<system-reminder>\\n片段1\\n片段2\\n...\\n</system-reminder>`，清空 Map。Map 为空时返回 `null`

### 2. React Hook

**文件**：`web/src/lib/use-context-queue.ts`

`useContextQueue(key: string, text: string | (() => string)): void`

内部用 `useEffect` 在 mount 时 `pushContext`，unmount 时 `removeContext`，text 变化时更新。支持函数形式以避免闭包陷阱。

### 3. 消息发送集成

**改动位置**：v2 Agent 面板中调用 `client.sendPrompt()` 的地方。

用户点击发送时：

1. 调用 `flushContext()` 获取上下文文本
2. 有上下文时，组装多 part 消息：
   ```typescript
   client.sendPrompt([
     { type: "text", text: `<system-reminder>\n${contextText}\n</system-reminder>` },
     { type: "text", text: userInput },
   ]);
   ```
3. 无上下文时，保持现有行为：`client.sendPrompt(userInput)`

**不需要改动的层**：ACP 协议、后端路由、WebSocket relay。

### 4. 前端渲染隐藏

**改动位置**：v2 Agent 面板的消息渲染入口。

在渲染消息的 content blocks 时，过滤掉 `<system-reminder>` block：

```typescript
function isVisibleContentBlock(block: ContentBlock): boolean {
  if (block.type !== "text") return true;
  const trimmed = block.text.trim();
  return !(trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>"));
}
```

对用户发送消息的回显生效：如果用户消息包含 `<system-reminder>` part，该 part 不渲染，只显示用户的实际输入文本。Assistant 回复中的内容正常渲染，不做过滤。

### 5. 首批上下文注册

在 v2 Agent 面板的路由层或布局组件中，注册路由级上下文：

```
当前页面: /agent/{agentId}
agentId: xxx
sessionId: yyy (如有)
```

通过 `useContextQueue("route", () => ...)` 在页面组件中注册，页面切换时自动更新，离开时自动移除。

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `web/src/lib/context-queue.ts` | 新建 | 模块级 Map + push/remove/flush |
| `web/src/lib/use-context-queue.ts` | 新建 | React hook 封装 |
| v2 Agent 面板 sendPrompt 调用处 | 修改 | 组装多 part 消息 |
| v2 Agent 面板消息渲染入口 | 修改 | 过滤 `<system-reminder>` block |
| v2 Agent 面板路由层/布局组件 | 修改 | 注册路由级上下文 |

## 边界情况

- **Queue 为空**：`flushContext()` 返回 `null`，消息正常发送，无额外 block
- **多个组件注册同 key**：后注册的覆盖先注册的（Map 语义）
- **组件 unmount 未调用 removeContext**：会导致残留，但 flush 后 Map 清空，影响仅限当次发送
- **`<system-reminder>` 标签出现在用户正常输入中**：只要不是以 `<system-reminder>` 开头且 `</system-reminder>` 结尾的完整包裹，不会被隐藏
- **ACP 协议兼容性**：`ContentBlock[]` 已被 `sendPrompt` 原生支持，无需改动
