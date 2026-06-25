# Card Renderer — LLM 自定义标签渲染注册架构

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个全局注册表机制，让 LLM 输出的自定义 XML 标签（如 `<agent-sites url="..."/>`）通过 streamdown 渲染为交互式 React 组件，并通过 context 注入的 emitter 向外部发送事件。

**Architecture:** 三层解耦。全局注册表（registry）管理标签→组件的映射，与 streamdown 的 `components` prop 对接。`MessageEmitterContext` 在消息粒度注入 emitter 实例，组件通过 `useCardEmit` hook 发事件。外部代码通过 emitter 实例订阅，完全解耦组件和监听者。

**Tech Stack:** React 19 Context + useMemo + streamdown `components`/`allowedTags` props，零外部依赖。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `web/src/lib/card-renderer/emitter.ts` | `CardEventEmitter` 类 — 轻量事件发射器 |
| `web/src/lib/card-renderer/context.tsx` | `MessageEmitterContext` + `useCardEmit` hook |
| `web/src/lib/card-renderer/registry.ts` | 全局注册表 + `getRegisteredComponents` / `getRegisteredAllowedTags` |
| `web/src/lib/card-renderer/index.ts` | barrel export |
| `web/components/chat/MessageBubble.tsx` (modify) | `AssistantBubble` — 创建 emitter、挂 Provider、暴露 emitterRef |
| `web/components/ai-elements/message.tsx` (modify) | `MessageResponse` — 合并注册表到 streamdown 的 `components` + `allowedTags` |

---

### Task 1: CardEventEmitter

**Files:**
- Create: `web/src/lib/card-renderer/emitter.ts`

- [ ] **Step 1: 创建 emitter.ts**

```typescript
type Handler<T = unknown> = (payload: T) => void;

/**
 * 轻量级事件发射器，用于卡片组件与外部代码通信。
 * 每个 AssistantBubble 消息创建独立实例，消息级别隔离。
 */
export class CardEventEmitter {
  private handlers = new Map<string, Set<Handler>>();

  /** 订阅事件，返回取消订阅函数 */
  on(event: string, handler: Handler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  /** 取消订阅 */
  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  /** 发送事件 */
  emit(event: string, payload?: unknown): void {
    this.handlers.get(event)?.forEach((handler) => handler(payload));
  }

  /** 清理所有订阅 */
  destroy(): void {
    this.handlers.clear();
  }
}
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run tsc --noEmit 2>&1 | head -5
```

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/card-renderer/emitter.ts
git commit -m "feat(card-renderer): add CardEventEmitter class"
```

---

### Task 2: MessageEmitterContext + useCardEmit

**Files:**
- Create: `web/src/lib/card-renderer/context.tsx`

- [ ] **Step 1: 创建 context.tsx**

```typescript
import { createContext, useContext } from "react";
import type { CardEventEmitter } from "./emitter";

/**
 * 消息粒度的 emitter 上下文。
 * 由 AssistantBubble 在渲染助手消息时注入，同一消息内的所有卡片组件共享同一 emitter 实例。
 */
export const MessageEmitterContext = createContext<CardEventEmitter | null>(null);

/**
 * 卡片组件使用此 hook 发送事件。
 * 若不在 MessageEmitterContext 内（例如组件被独立使用），返回 noop 函数，不抛错。
 *
 * 用法：
 * ```tsx
 * function SitesCard({ url }: { url: string }) {
 *   const emit = useCardEmit();
 *   useEffect(() => { emit("render", { url }); }, []);
 *   return <div onClick={() => emit("open", { url })}>...</div>;
 * }
 * ```
 */
export function useCardEmit() {
  const emitter = useContext(MessageEmitterContext);
  if (!emitter) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return (_event: string, _payload?: unknown) => {
      // noop — 组件在 Provider 外部被使用
    };
  }
  return (event: string, payload?: unknown) => {
    emitter.emit(event, payload);
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/lib/card-renderer/context.tsx
git commit -m "feat(card-renderer): add MessageEmitterContext and useCardEmit hook"
```

---

### Task 3: 全局注册表

**Files:**
- Create: `web/src/lib/card-renderer/registry.ts`

- [ ] **Step 1: 创建 registry.ts**

```typescript
import type { ComponentType } from "react";

export interface TagRendererConfig {
  /** 卡片组件，接收标签属性（均为 string 类型）作为 props */
  component: ComponentType<Record<string, unknown>>;
  /** 可选：加载中占位组件 */
  fallback?: ComponentType<Record<string, unknown>>;
}

const registry = new Map<string, TagRendererConfig>();

/**
 * 注册自定义标签渲染器。
 * 标签名使用 kebab-case（如 "agent-sites"），无需尖括号。
 * 注册后 streamdown 的 allowedTags 自动包含此标签，components 自动注入。
 *
 * 用法：
 * ```ts
 * registerTagRenderer("agent-sites", { component: SitesCard });
 * ```
 */
export function registerTagRenderer(tagName: string, config: TagRendererConfig): void {
  if (registry.has(tagName)) {
    console.warn(`[card-renderer] Tag "${tagName}" is being overwritten`);
  }
  registry.set(tagName, config);
}

/** 获取单个标签的渲染器配置 */
export function getTagRenderer(tagName: string): TagRendererConfig | undefined {
  return registry.get(tagName);
}

/** 获取所有已注册的标签名 */
export function getRegisteredTags(): string[] {
  return Array.from(registry.keys());
}

/**
 * 生成 streamdown `components` prop 的组件映射。
 * 从注册表中提取所有标签→组件的映射。
 */
export function getRegisteredComponents(): Record<string, ComponentType<Record<string, unknown>>> {
  const components: Record<string, ComponentType<Record<string, unknown>>> = {};
  for (const [tag, config] of registry) {
    components[tag] = config.component;
  }
  return components;
}

/**
 * 生成 streamdown `allowedTags` prop 的白名单。
 * 每个标签允许所有属性（传递 "*"），由 rehype-sanitize 放行。
 */
export function getRegisteredAllowedTags(): Record<string, string[]> {
  const tags: Record<string, string[]> = {};
  for (const [tag] of registry) {
    tags[tag] = ["*"];
  }
  return tags;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/lib/card-renderer/registry.ts
git commit -m "feat(card-renderer): add global tag renderer registry"
```

---

### Task 4: Barrel export

**Files:**
- Create: `web/src/lib/card-renderer/index.ts`

- [ ] **Step 1: 创建 index.ts**

```typescript
export { registerTagRenderer, getTagRenderer, getRegisteredTags, getRegisteredComponents, getRegisteredAllowedTags } from "./registry";
export type { TagRendererConfig } from "./registry";
export { CardEventEmitter } from "./emitter";
export { MessageEmitterContext, useCardEmit } from "./context";
```

- [ ] **Step 2: Commit**

```bash
git add web/src/lib/card-renderer/index.ts
git commit -m "feat(card-renderer): add barrel export"
```

---

### Task 5: AssistantBubble 集成

**Files:**
- Modify: `web/components/chat/MessageBubble.tsx:90-137`

- [ ] **Step 1: 修改 AssistantBubble — 创建 emitter、挂 Provider、暴露 emitterRef**

当前代码（L90-137）：

```tsx
interface AssistantBubbleProps {
  entry: AssistantMessageEntry;
  isStreaming?: boolean;
  sessionId?: string;
  envId?: string;
}

export function AssistantBubble({ entry, isStreaming, envId }: AssistantBubbleProps) {
  return (
    <div className="flex gap-4 items-start message-bubble-enter">
      <AgentAvatar className="hidden md:flex mt-0.5" />
      <div className="flex-1 min-w-0 space-y-4">
        {entry.chunks
          .filter((chunk) => {
            if (chunk.type === "thought") return true;
            return isVisibleContentBlock({ type: "text", text: chunk.text });
          })
          .map((chunk, i, filtered) => {
            if (chunk.type === "thought") {
              const isLastThought =
                i === filtered.length - 1 || filtered.slice(i + 1).every((c) => c.type !== "thought");
              const thoughtStreaming = isStreaming && isLastThought;
              return (
                <Reasoning key={i} isStreaming={thoughtStreaming}>
                  <ReasoningTrigger />
                  <ReasoningContent>
                    <ThoughtContent text={chunk.text} isStreaming={thoughtStreaming} />
                  </ReasoningContent>
                </Reasoning>
              );
            }
            return (
              <div key={i} className="message-content text-text-primary leading-[1.75]">
                <MessageResponse envId={envId}>{chunk.text}</MessageResponse>
              </div>
            );
          })}
      </div>
    </div>
  );
}
```

修改为：

```tsx
import { useMemo, useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { CardEventEmitter, MessageEmitterContext, getRegisteredComponents, getRegisteredAllowedTags } from "@/src/lib/card-renderer";

interface AssistantBubbleProps {
  entry: AssistantMessageEntry;
  isStreaming?: boolean;
  sessionId?: string;
  envId?: string;
  /** 外部监听器通过此 ref 获取 emitter 实例进行订阅 */
  cardEmitterRef?: React.MutableRefObject<CardEventEmitter | null>;
}

export function AssistantBubble({ entry, isStreaming, envId, cardEmitterRef }: AssistantBubbleProps) {
  // 每个助手消息创建独立的 emitter 实例
  const emitter = useMemo(() => new CardEventEmitter(), [entry.id]);

  // 暴露 emitter 给外部监听器
  useEffect(() => {
    if (cardEmitterRef) {
      cardEmitterRef.current = emitter;
    }
    return () => {
      if (cardEmitterRef) {
        cardEmitterRef.current = null;
      }
      emitter.destroy();
    };
  }, [emitter, cardEmitterRef]);

  return (
    <MessageEmitterContext.Provider value={emitter}>
      <div className="flex gap-4 items-start message-bubble-enter">
        <AgentAvatar className="hidden md:flex mt-0.5" />
        <div className="flex-1 min-w-0 space-y-4">
          {entry.chunks
            .filter((chunk) => {
              if (chunk.type === "thought") return true;
              return isVisibleContentBlock({ type: "text", text: chunk.text });
            })
            .map((chunk, i, filtered) => {
              if (chunk.type === "thought") {
                const isLastThought =
                  i === filtered.length - 1 || filtered.slice(i + 1).every((c) => c.type !== "thought");
                const thoughtStreaming = isStreaming && isLastThought;
                return (
                  <Reasoning key={i} isStreaming={thoughtStreaming}>
                    <ReasoningTrigger />
                    <ReasoningContent>
                      <ThoughtContent text={chunk.text} isStreaming={thoughtStreaming} />
                    </ReasoningContent>
                  </Reasoning>
                );
              }
              return (
                <div key={i} className="message-content text-text-primary leading-[1.75]">
                  <MessageResponse envId={envId}>{chunk.text}</MessageResponse>
                </div>
              );
            })}
        </div>
      </div>
    </MessageEmitterContext.Provider>
  );
}
```

- [ ] **Step 2: 更新 import 语句**

在 `MessageBubble.tsx` 顶部已有的 import block 中追加：

```typescript
import { useMemo, useEffect } from "react";
import { CardEventEmitter, MessageEmitterContext } from "@/src/lib/card-renderer";
```

（如果 `useMemo` 和 `useEffect` 已在现有 import 中则合并）

- [ ] **Step 3: 确认 ChatView 调用兼容**

检查 `web/components/chat/ChatView.tsx:165` 处的调用：

```tsx
// 当前
<AssistantBubble entry={entry} isStreaming={isLoading} sessionId={sessionId} envId={envId} />
```

`cardEmitterRef` 为可选属性，不传不影响现有行为。编译无报错即可。

- [ ] **Step 4: 验证 TypeScript 编译通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add web/components/chat/MessageBubble.tsx
git commit -m "feat(card-renderer): integrate emitter context into AssistantBubble"
```

---

### Task 6: MessageResponse 集成 — 合并注册表组件

**Files:**
- Modify: `web/components/ai-elements/message.tsx:366-410`

- [ ] **Step 1: 修改 MessageResponse — 合并注册表到 streamdown props**

当前 `MessageResponse` 组件内 streamdown 的 props（L384-408）：

```tsx
<LazyStreamdown
  allowedTags={{
    iframe: ["src", "width", "height", "title", "sandbox", "loading"],
  }}
  components={{
    img: (({ src, alt, ...rest }: Record<string, unknown>) => (
      // ...img renderer...
    )) as unknown as undefined,
    iframe: ((props: Record<string, unknown>) => <IframePreview {...props} />) as unknown as undefined,
  }}
  urlTransform={urlTransform}
  className={cn(
    "size-full break-words [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
    className,
  )}
  {...props}
>
  {children}
</LazyStreamdown>
```

修改为合并注册表的 `allowedTags` 和 `components`：

```tsx
<LazyStreamdown
  allowedTags={useMemo(() => {
    const base: Record<string, string[]> = {
      iframe: ["src", "width", "height", "title", "sandbox", "loading"],
    };
    // 合并注册表中已注册的标签白名单
    const registered = getRegisteredAllowedTags();
    return { ...base, ...registered };
  }, [])}
  components={useMemo(() => {
    const base: Record<string, unknown> = {
      img: (({ src, alt, ...rest }: Record<string, unknown>) => (
        <img
          src={src as string}
          alt={(alt as string) || ""}
          style={{ maxWidth: "100%", maxHeight: "50vh", objectFit: "contain" }}
          {...Object.fromEntries(Object.entries(rest).filter(([k]) => !["children", "node"].includes(k)))}
        />
      )) as unknown as undefined,
      iframe: ((props: Record<string, unknown>) => <IframePreview {...props} />) as unknown as undefined,
    };
    // 合并注册表中已注册的标签组件
    const registered = getRegisteredComponents();
    // 注：若有标签名与已有组件名冲突，注册表优先
    return { ...base, ...registered } as Record<string, unknown>;
  }, [])}
  urlTransform={urlTransform}
  className={cn(
    "size-full break-words [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
    className,
  )}
  {...props}
>
  {children}
</LazyStreamdown>
```

- [ ] **Step 2: 更新 import**

在 `web/components/ai-elements/message.tsx` 顶部追加：

```typescript
import { getRegisteredAllowedTags, getRegisteredComponents } from "@/src/lib/card-renderer";
import { useMemo } from "react";
```

（`useMemo` 若已在现有 import 中则合并）

- [ ] **Step 3: 验证 TypeScript 编译通过**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add web/components/ai-elements/message.tsx
git commit -m "feat(card-renderer): merge registry into MessageResponse streamdown props"
```

---

### Task 7: 端到端验证 — 注册一个演示组件

**Files:**
- Demo: 验证注册→渲染→事件发送全链路

- [ ] **Step 1: 创建演示卡片组件**

创建临时文件 `web/src/lib/card-renderer/__demo__/SitesCard.tsx`（仅用于手动验证，验证后删除）：

```tsx
import { useEffect } from "react";
import { useCardEmit } from "../context";

export function SitesCard({ url }: { url?: string }) {
  const emit = useCardEmit();

  useEffect(() => {
    emit("render", { type: "agent-sites", url });
  }, []);

  return (
    <div
      onClick={() => emit("open", { url })}
      className="rounded-lg border border-border p-3 cursor-pointer hover:bg-accent transition-colors"
    >
      <div className="text-sm font-medium">🌐 External Site</div>
      <div className="text-xs text-text-muted truncate">{url || "(no url)"}</div>
    </div>
  );
}
```

- [ ] **Step 2: 在应用入口注册**

在 `web/src/main.tsx` 或应用启动文件顶部插入：

```typescript
import { registerTagRenderer } from "@/src/lib/card-renderer";
import { SitesCard } from "@/src/lib/card-renderer/__demo__/SitesCard";

registerTagRenderer("agent-sites", { component: SitesCard });
```

- [ ] **Step 3: 手动验证 — 让 LLM 输出带标签的 markdown**

在聊天中输入以下内容作为 system prompt 或直接测试：

```markdown
看看这个网站：

<agent-sites url="https://example.com"/>
```

验证点：
1. streamdown 正确渲染卡片组件（而非纯文本 `<agent-sites...`）
2. 卡片可点击
3. `useCardEmit` 发出的事件可在 `cardEmitterRef` 中监听到

- [ ] **Step 4: 清理演示文件**

```bash
rm -rf web/src/lib/card-renderer/__demo__/
```

撤销 `main.tsx` 中的演示注册代码。

- [ ] **Step 5: Commit**

```bash
# 无需提交 — 仅本地验证
```

---

### Task 8: 运行 precheck

- [ ] **Step 1: 运行 precheck 确保代码质量**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

预期：formatting + import sort + tsc + biome check 全部通过。

- [ ] **Step 2: 如有问题，修复后重新 precheck**

---

## 验证检查清单

实现完成后，确认以下行为：

- [ ] `registerTagRenderer("agent-sites", { component: SitesCard })` 注册成功
- [ ] streamdown 的 `allowedTags` 包含 `agent-sites`
- [ ] streamdown 的 `components` 包含 `agent-sites` → `SitesCard`
- [ ] AssistantBubble 创建独立 emitter 实例，通过 `MessageEmitterContext` 注入
- [ ] 卡片组件通过 `useCardEmit` 发事件，外部通过 `cardEmitterRef` 监听
- [ ] 未注册组件时，`getRegisteredAllowedTags` 返回空对象，不影响现有行为
- [ ] `bun run precheck` 通过
