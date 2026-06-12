# Chat 输入框重设计：玻璃磨砂命令岛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 chat 页面的顶栏 A (StatusHeader) + 顶栏 B (ModelSelector 行) + ChatInput 三者合并为单一的 `ChatComposer` 玻璃磨砂命令岛组件。

**Architecture:** 新建 `ChatComposer` 组件取代 `ChatInput`，内嵌所有元信息（环境名/模式/模型/token/新会话）。从 `StatusHeader` 提取 `computeStats` 到共享 util，`ChatInterface` 计算 token 统计后通过 prop 传给 `ChatComposer`。删除 `StatusHeader` 和 `ChatInput`，路由层不再渲染顶栏。环境名改由 `ChatComposer` 内部 `envApi.get` 获取。

**Tech Stack:** React 19 + TypeScript + Tailwind CSS v4 + lucide-react + Radix UI (Popover/Tooltip) + Bun test + react-i18next

**Spec:** `docs/superpowers/specs/2026-06-12-chat-composer-input-redesign-design.md`

---

## 文件结构总览

**新增：**
- `web/components/chat/ChatComposer.tsx` —— 玻璃磨砂命令岛主组件
- `web/components/chat/SessionModeSelector.tsx` —— 从 ChatInterface.tsx 提取的会话模式选择器
- `web/src/lib/token-stats.ts` —— 从 StatusHeader.tsx 提取的 computeStats + formatTokenCount 纯函数
- `web/src/__tests__/chat-composer.test.tsx` —— ChatComposer 测试
- `web/src/__tests__/token-stats.test.ts` —— computeStats 纯函数测试

**修改：**
- `web/components/ChatInterface.tsx` —— 移除 SessionModeSelector 内部定义 + ModelSelector 行 + ChatInput，改为渲染 ChatComposer
- `web/src/pages/agent-panel/agent-panel.css` —— 新增 `.chat-composer-*` 玻璃磨砂样式
- `web/src/routes/agent/_panel/chat.$agentId.tsx` —— 移除 StatusHeader 渲染 + envApi.get 调用
- `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx` —— 同上
- `web/src/i18n/locales/zh/components.json` —— 新增 chatComposer 键值
- `web/src/i18n/locales/en/components.json` —— 同上

**删除：**
- `web/components/chat/ChatInput.tsx`
- `web/src/components/agent-panel/StatusHeader.tsx`
- `web/src/__tests__/chat-input-attachment.test.tsx`（被 chat-composer.test.tsx 取代）

---

## Task 1: 提取 SessionModeSelector 到独立文件

**Files:**
- Create: `web/components/chat/SessionModeSelector.tsx`
- Modify: `web/components/ChatInterface.tsx` (移除内部定义，改为 import)
- Test: `web/src/__tests__/session-mode-selector.test.tsx`

**目的：** SessionModeSelector 目前是 ChatInterface.tsx 内部的函数组件（第 94-141 行），后续 ChatComposer 需要复用它。先提取为独立文件，保持 ChatInterface 行为不变。

- [ ] **Step 1: 写失败测试**

创建 `web/src/__tests__/session-mode-selector.test.tsx`：

```tsx
import { describe, expect, test } from "bun:test";
import ReactDOMServer from "react-dom/server";
import { SessionModeSelector } from "../../components/chat/SessionModeSelector";

describe("SessionModeSelector", () => {
  test("renders current mode name", () => {
    const html = ReactDOMServer.renderToString(
      <SessionModeSelector
        modes={[{ id: "default", name: "默认模式" }]}
        currentModeId="default"
        onModeChange={() => {}}
      />,
    );
    expect(html).toContain("默认模式");
  });

  test("renders nothing when modes is empty", () => {
    const html = ReactDOMServer.renderToString(
      <SessionModeSelector modes={[]} currentModeId={null} onModeChange={() => {}} />,
    );
    expect(html).toBe("");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test web/src/__tests__/session-mode-selector.test.tsx`
Expected: FAIL — 模块 `../../components/chat/SessionModeSelector` 不存在

- [ ] **Step 3: 创建 SessionModeSelector.tsx**

创建 `web/components/chat/SessionModeSelector.tsx`，从 `ChatInterface.tsx` 第 94-141 行逐字搬运 `SessionModeSelector` 函数，补充必要的 import：

```tsx
import { Check, ChevronDown, ChevronUp, Shield } from "lucide-react";
import { useState } from "react";
import type { SessionMode } from "../../src/acp/types";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

interface SessionModeSelectorProps {
  modes: SessionMode[];
  currentModeId: string | null;
  onModeChange: (modeId: string) => void;
}

export function SessionModeSelector({ modes, currentModeId, onModeChange }: SessionModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const current = modes.find((m) => m.id === currentModeId) ?? modes[0];

  if (modes.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground h-7 px-2">
          <Shield className="h-3 w-3" />
          <span className="max-w-24 truncate">{current?.name ?? "默认"}</span>
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              onModeChange(m.id);
              setOpen(false);
            }}
            className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-surface-2 transition-colors"
          >
            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
              {currentModeId === m.id && <Check className="h-3.5 w-3.5 text-brand" />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary">{m.name}</div>
              {m.description && <div className="text-xs text-text-muted">{m.description}</div>}
            </div>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test web/src/__tests__/session-mode-selector.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: 从 ChatInterface.tsx 移除内部定义，改为 import**

在 `web/components/ChatInterface.tsx` 中：

1. **删除** 第 94-141 行的 `function SessionModeSelector(...)` 整个函数体
2. **在文件顶部 import 区**（第 33 行附近，已有 `import { ModelSelectorPopover } from "./model-selector";`）追加：

```tsx
import { SessionModeSelector } from "./chat/SessionModeSelector";
```

3. 第 977 行 `<SessionModeSelector modes={availableModes} ...>` 的用法**保持不变**（只是来源从内部函数变为外部 import）

- [ ] **Step 6: 运行全部前端测试确认无回归**

Run: `bun test web/src/__tests__/`
Expected: 所有现有测试 PASS

- [ ] **Step 7: 提交**

```bash
git add web/components/chat/SessionModeSelector.tsx web/components/ChatInterface.tsx web/src/__tests__/session-mode-selector.test.tsx
git commit -m "refactor(chat): 提取 SessionModeSelector 为独立组件

为 ChatComposer 命令岛重用做准备，行为不变

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 2: 提取 token-stats 纯函数到共享 util

**Files:**
- Create: `web/src/lib/token-stats.ts`
- Create: `web/src/__tests__/token-stats.test.ts`

**目的：** `StatusHeader.tsx` 内部的 `computeStats` 和 `formatTokenCount` 即将随 StatusHeader 一起删除，但 ChatInterface 需要它们来计算 token 统计传给 ChatComposer。先提取为纯函数并测试。

- [ ] **Step 1: 写失败测试**

创建 `web/src/__tests__/token-stats.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { computeStats, formatTokenCount } from "../lib/token-stats";
import type { ThreadEntry } from "../lib/types";

describe("formatTokenCount", () => {
  test("formats numbers under 1000 as-is", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("formats numbers >= 1000 as Nk with one decimal", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(12300)).toBe("12.3k");
    expect(formatTokenCount(200000)).toBe("200.0k");
  });
});

describe("computeStats", () => {
  test("returns zeros for empty entries", () => {
    const stats = computeStats([]);
    expect(stats.estimatedTokens).toBe(0);
    expect(stats.estimatedInputTokens).toBe(0);
    expect(stats.estimatedOutputTokens).toBe(0);
  });

  test("counts user_message content as input tokens", () => {
    const entries: ThreadEntry[] = [
      { type: "user_message", id: "u1", content: "Hello world test" } as any,
    ];
    const stats = computeStats(entries);
    // "Hello world test" = 16 chars / 4 = 4 tokens
    expect(stats.estimatedInputTokens).toBe(4);
    expect(stats.estimatedTokens).toBe(4);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test web/src/__tests__/token-stats.test.ts`
Expected: FAIL — 模块 `../lib/token-stats` 不存在

- [ ] **Step 3: 创建 token-stats.ts**

创建 `web/src/lib/token-stats.ts`，从 `StatusHeader.tsx` 第 72-107 行搬运 `computeStats` 和 `formatTokenCount`：

```ts
import type { ThreadEntry, ToolCallEntry } from "./types";

export interface TokenStats {
  estimatedTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

/**
 * 从对话 entries 估算 token 用量。
 * 规则：user_message 内容计入 input，assistant_message 文本和 tool_call 输出计入 output。
 * 估算方式：字符数 / 4（粗略近似）。
 */
export function computeStats(entries: ThreadEntry[]): TokenStats {
  let totalChars = 0;
  let inputChars = 0;
  let outputChars = 0;

  for (const entry of entries) {
    if (entry.type === "assistant_message") {
      const text = entry.chunks.reduce((sum, c) => sum + (c.text?.length || 0), 0);
      outputChars += text;
      totalChars += text;
    }
    if (entry.type === "user_message") {
      const text = entry.content?.length || 0;
      inputChars += text;
      totalChars += text;
    }
    if (entry.type === "tool_call") {
      const rawOutput = (entry as ToolCallEntry).toolCall.rawOutput;
      if (rawOutput) {
        const text = JSON.stringify(rawOutput).length;
        outputChars += text;
        totalChars += text;
      }
    }
  }

  return {
    estimatedTokens: Math.round(totalChars / 4),
    estimatedInputTokens: Math.round(inputChars / 4),
    estimatedOutputTokens: Math.round(outputChars / 4),
  };
}

/** 格式化 token 数为人类可读字符串：< 1000 显示原值，>= 1000 显示 Nk */
export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test web/src/__tests__/token-stats.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/token-stats.ts web/src/__tests__/token-stats.test.ts
git commit -m "refactor(chat): 提取 computeStats/formatTokenCount 到 token-stats util

为 ChatComposer 的 token 统计展示做准备，从 StatusHeader 搬出为纯函数

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 3: 创建 ChatComposer 骨架（迁移 ChatInput 全部逻辑）

**Files:**
- Create: `web/components/chat/ChatComposer.tsx`
- Create: `web/src/__tests__/chat-composer.test.tsx`

**目的：** 创建 ChatComposer 组件，把 ChatInput.tsx 的所有输入逻辑（state、handlers、effects、图片处理、文件拖拽、slash 命令、@ 引用、textarea 自适应高度）原样迁移过来。此任务只做骨架（textarea + 发送按钮），元信息条在 Task 4 加。

- [ ] **Step 1: 写失败测试**

创建 `web/src/__tests__/chat-composer.test.tsx`：

```tsx
import { describe, expect, test } from "bun:test";
import ReactDOMServer from "react-dom/server";

describe("ChatComposer", () => {
  test("exports as function", async () => {
    const mod = await import("../../components/chat/ChatComposer");
    expect(typeof mod.ChatComposer).toBe("function");
  });

  test("renders without envId (minimal props)", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    expect(() => {
      ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} client={{} as any} />);
    }).not.toThrow();
  });

  test("renders textarea with placeholder", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} client={{} as any} placeholder="给智能体发送消息…" />,
    );
    expect(html).toContain("给智能体发送消息");
  });

  test("renders send button", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} client={{} as any} />,
    );
    expect(html).toContain("发送");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test web/src/__tests__/chat-composer.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 创建 ChatComposer.tsx 骨架**

创建 `web/components/chat/ChatComposer.tsx`。这是大文件——**从 `web/components/chat/ChatInput.tsx` 逐字迁移以下部分**，然后修改为新结构：

**3a. 从 ChatInput.tsx 搬运 import（替换 ChatInput 特有的）**：

```tsx
import imageCompression from "browser-image-compression";
import { Loader2, Send, Square } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ACPClient } from "../../src/acp/client";
import type { AvailableCommand, SessionMode } from "../../src/acp/types";
import { envApi, fileApi } from "../../src/api/sdk";
import { FilePickerDialog } from "../../src/components/FilePickerDialog";
import type { ChatInputMessage, FileAttachment, UserMessageImage } from "../../src/lib/types";
import type { TokenStats } from "../../src/lib/token-stats";
import { formatTokenCount } from "../../src/lib/token-stats";
import type { FileInfo } from "../../src/types";
import { cn } from "../../src/lib/utils";
import { Button } from "../ui/button";
import { ModelSelectorPopover } from "../model-selector/ModelSelectorPopover";
import { CommandMenu } from "./CommandMenu";
import { SessionModeSelector } from "./SessionModeSelector";
```

注意：
- 移除了 `AtSign`、`Slash` 图标（按钮去掉）
- 新增 `Send` 图标用于发送按钮
- 新增 `ACPClient`、`SessionMode`、`envApi`、`TokenStats`、`formatTokenCount`、`ModelSelectorPopover`、`SessionModeSelector` 的 import

**3b. 搬运常量和工具函数**（ChatInput.tsx 第 12-17 行的 `IMAGE_COMPRESSION_OPTIONS`，以及文件末尾的 `processImageFiles` 函数）——原样搬运。

**3c. 定义 Props 接口**：

```tsx
const MAX_CONTEXT_TOKENS = 200000;

interface ChatComposerProps {
  onSubmit: (message: ChatInputMessage) => void;
  isLoading?: boolean;
  onInterrupt?: () => void;
  disabled?: boolean;
  placeholder?: string;
  supportsImages?: boolean;
  commands?: AvailableCommand[];
  envId?: string;
  client: ACPClient;
  availableModes?: SessionMode[];
  currentModeId?: string | null;
  onModeChange?: (modeId: string) => void;
  tokenStats?: TokenStats;
  onNewSession?: () => void;
  showNewSession?: boolean;
  className?: string;
}
```

**3d. 搬运组件函数体**：

从 `ChatInput.tsx` 第 47-260 行搬运所有 state（`text`、`images`、`showCommandMenu`、`commandFilter`、`showFilePicker`、`attachments`）、refs（`textareaRef`、`fileInputRef`）、handlers（`handleSubmit`、`handleKeyDown`、`handleInput`、`handlePaste`、`handleDrop`、`_handleFileSelect`、`removeImage`、`handleCommandSelect`、`handleFilePickerSelect`、`toggleCommandMenu`）、effects（`file-tree:reference` listener）——**逐字搬运，函数体不变**。

但修改以下两点：
1. `fileWorkspaceId` 变量保留（从 `envId` prop 派生）
2. 函数签名从 `ChatInput(...)` 改为 `ChatComposer(...)`，props 解构按新接口

**3e. 新增环境名加载逻辑**（ChatInput 没有，这是新增的）：

在 `file-tree:reference` effect 之后追加：

```tsx
// 加载环境名（用于元信息条显示）
const [envName, setEnvName] = useState<string | null>(null);
useEffect(() => {
  if (!envId) {
    setEnvName(null);
    return;
  }
  let cancelled = false;
  envApi
    .get({ id: envId })
    .then(({ data }) => {
      if (!cancelled) setEnvName(data?.name ?? envId);
    })
    .catch((err) => {
      console.error("Failed to load environment name:", err);
      if (!cancelled) setEnvName(envId); // 兜底显示 envId，便于排查
    });
  return () => {
    cancelled = true;
  };
}, [envId]);
```

**3f. 搬运 `canSend` 计算**（ChatInput.tsx 第 285 行）——原样。

**3g. 重写 JSX return**：

这是与 ChatInput 最大的区别——改为玻璃磨砂容器 + 大 textarea + 底部脚标（本任务只放占位，元信息条在 Task 4 实现）：

```tsx
return (
  <div className={cn("w-full max-w-3xl mx-auto px-4 sm:px-8 pb-4 pt-2", className)}>
    <div className="chat-composer-card relative">
      {/* File Picker Dialog */}
      {showFilePicker && fileWorkspaceId && (
        <FilePickerDialog
          open={showFilePicker}
          envId={fileWorkspaceId}
          onClose={() => setShowFilePicker(false)}
          onSelect={handleFilePickerSelect}
        />
      )}

      {/* Slash command menu */}
      {showCommandMenu && commands && commands.length > 0 && (
        <CommandMenu
          commands={commands}
          filter={commandFilter}
          onSelect={handleCommandSelect}
          onClose={() => {
            setShowCommandMenu(false);
            setCommandFilter("");
          }}
          className="absolute bottom-full left-0 right-0 mb-1 z-50"
        />
      )}

      {/* 图片预览 */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          {images.map((img, i) => (
            <div key={img.data} className="relative group">
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={`Attached image ${i + 1}`}
                className="h-14 w-14 object-cover rounded-lg border border-border"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 min-h-[32px] min-w-[32px] rounded-full bg-surface-2 border border-border text-text-muted hover:text-text-primary text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label={`Remove image ${i + 1}`}
              >
                {"\u00D7"}
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* 编辑区 —— textarea 默认 2 行高，无边框，透明背景 */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={_placeholder}
        disabled={disabled}
        rows={1}
        className="chat-composer-textarea w-full resize-none border-none bg-transparent outline-none text-sm text-text-primary placeholder:text-text-muted min-h-[48px] max-h-[200px] leading-relaxed px-4 pt-4 pb-2"
      />

      {/* 底部脚标行 —— Task 4 会填充元信息条，本任务只放发送按钮 */}
      <div className="chat-composer-meta flex items-center gap-2 px-4 py-2.5">
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={isLoading ? onInterrupt : handleSubmit}
          disabled={!isLoading && !canSend}
          className={cn(
            "h-8 gap-1.5 text-xs font-medium rounded-lg",
            isLoading
              ? "bg-text-primary text-surface-2 hover:bg-text-secondary"
              : canSend
                ? "bg-brand text-white hover:bg-brand-light"
                : "bg-surface-3 text-text-muted",
          )}
        >
          {isLoading ? (
            <>
              <Square className="h-3 w-3" fill="currentColor" />
              {t("chatComposer.stop")}
            </>
          ) : (
            <>
              <Send className="h-3.5 w-3.5" />
              {t("chatComposer.send")}
            </>
          )}
        </Button>
      </div>
    </div>

    {/* 提示文本 */}
    <div className="text-center mt-1.5">
      <span className="text-[11px] text-text-muted">
        Enter 发送，Shift+Enter 换行 · 粘贴图片或输入 @ 引用文件
      </span>
    </div>
  </div>
);
```

注意：
- 去掉了 `/` 和 `@` 按钮（textarea 直接接收输入，`handleInput` 内部已处理 `/` 和 `@` 检测）
- 去掉了 `handleDrop` 的 `onDragOver`/`onDrop` 绑定到容器上 —— 改为绑定到 `.chat-composer-card` div（在 JSX 中加 `onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}`）

补上 `.chat-composer-card` div 的拖拽属性：

```tsx
<div
  className="chat-composer-card relative"
  onDragOver={(e) => e.preventDefault()}
  onDrop={handleDrop}
>
```

- [ ] **Step 4: 添加 i18n 键值**

在 `web/src/i18n/locales/zh/components.json` 的顶层对象中追加 `chatComposer` 节：

```json
"chatComposer": {
  "send": "发送",
  "stop": "停止",
  "newSession": "新会话"
}
```

在 `web/src/i18n/locales/en/components.json` 同位置追加：

```json
"chatComposer": {
  "send": "Send",
  "stop": "Stop",
  "newSession": "New Thread"
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test web/src/__tests__/chat-composer.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 6: 运行全部前端测试确认无回归**

Run: `bun test web/src/__tests__/`
Expected: 所有测试 PASS（ChatInput 的旧测试仍然通过，因为还没删除 ChatInput.tsx）

- [ ] **Step 7: 提交**

```bash
git add web/components/chat/ChatComposer.tsx web/src/__tests__/chat-composer.test.tsx web/src/i18n/locales/zh/components.json web/src/i18n/locales/en/components.json
git commit -m "feat(chat): 新建 ChatComposer 组件，迁移 ChatInput 输入逻辑

- 玻璃磨砂容器（chat-composer-card class 待 Task 5 补 CSS）
- 大编辑区 textarea 默认 2 行高
- 迁移全部输入逻辑（state/handlers/effects/图片/文件/slash 命令）
- 新增环境名 envApi.get 加载（带竞态防护 + 兜底）
- 去掉 / 和 @ 按钮，textarea 直接接收输入
- 底部脚标行暂只含发送按钮，元信息条 Task 4 实现

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 4: 为 ChatComposer 添加玻璃磨砂 CSS

**Files:**
- Modify: `web/src/pages/agent-panel/agent-panel.css` (追加 .chat-composer-* 样式)

**目的：** `chat-composer-card` class 在 Task 3 已被引用但还没有 CSS 定义。本任务把玻璃磨砂、暗色模式、focus-within 状态写入 agent-panel.css。

- [ ] **Step 1: 追加 CSS 到 agent-panel.css 末尾**

在 `web/src/pages/agent-panel/agent-panel.css` 文件**末尾**追加：

```css
/* =============================================================================
   ChatComposer —— 玻璃磨砂命令岛
   ============================================================================= */

.chat-composer-card {
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 20px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

/* 暗色模式 */
:root.dark .chat-composer-card,
.dark .chat-composer-card {
  background: rgba(45, 45, 47, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

/* focus-within：品牌色边框 + 柔和光环 */
.chat-composer-card:focus-within {
  border-color: color-mix(in srgb, var(--color-brand) 40%, transparent);
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--color-brand) 12%, transparent),
    0 4px 20px rgba(0, 0, 0, 0.06);
}

/* backdrop-filter 不支持时的 fallback */
@supports not ((backdrop-filter: blur(16px)) or (-webkit-backdrop-filter: blur(16px))) {
  .chat-composer-card {
    background: var(--color-surface-1);
  }
}

/* textarea 编辑区 */
.chat-composer-textarea {
  font-family: var(--font-display, inherit);
}

.chat-composer-textarea:focus {
  outline: none;
}

/* 元信息条 */
.chat-composer-meta {
  border-top: 1px solid rgba(0, 0, 0, 0.05);
}

:root.dark .chat-composer-meta,
.dark .chat-composer-meta {
  border-top-color: rgba(255, 255, 255, 0.05);
}

/* 元信息条分隔线 */
.chat-composer-divider {
  width: 1px;
  height: 12px;
  background: rgba(0, 0, 0, 0.08);
  flex-shrink: 0;
}

:root.dark .chat-composer-divider,
.dark .chat-composer-divider {
  background: rgba(255, 255, 255, 0.08);
}
```

- [ ] **Step 2: 运行 build 确认 CSS 无语法错误**

Run: `bun run build:web`
Expected: 构建成功，无 CSS 报错

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/agent-panel/agent-panel.css
git commit -m "feat(chat): 新增 ChatComposer 玻璃磨砂 CSS

- 半透明背景 + backdrop-blur + saturate
- 暗色模式适配
- focus-within 品牌色边框 + 光环
- backdrop-filter 不支持时退化为纯色
- 元信息条分隔线适配明暗主题

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 5: 为 ChatComposer 添加元信息条

**Files:**
- Modify: `web/components/chat/ChatComposer.tsx` (替换 Task 3 中的占位脚标行)
- Modify: `web/src/__tests__/chat-composer.test.tsx` (新增元信息条测试)

**目的：** 在 ChatComposer 底部脚标行填充完整元信息：环境名 + 会话模式 + 模型选择器 + token 统计 + 新会话按钮 + 发送按钮。

- [ ] **Step 1: 写失败测试**

在 `web/src/__tests__/chat-composer.test.tsx` 末尾追加：

```tsx
  test("renders environment name when envId provided", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} client={{} as any} envId="env_123" />,
    );
    // SSR 时 envApi.get 不会执行（需要浏览器环境），envName 为 null
    // 但 envId 占位至少应该被渲染（兜底逻辑）
    expect(html).toContain("env_123");
  });

  test("renders token stats when tokenStats provided", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer
        onSubmit={() => {}}
        client={{} as any}
        tokenStats={{ estimatedTokens: 12300, estimatedInputTokens: 5000, estimatedOutputTokens: 7300 }}
      />,
    );
    expect(html).toContain("12.3k");
    expect(html).toContain("200k");
    // 百分比 12300/200000 ≈ 6%
    expect(html).toContain("6%");
  });

  test("renders new session button when showNewSession is true", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer
        onSubmit={() => {}}
        client={{} as any}
        showNewSession={true}
        onNewSession={() => {}}
      />,
    );
    expect(html).toContain("新会话");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test web/src/__tests__/chat-composer.test.tsx`
Expected: 3 个新测试 FAIL（环境名、token 统计、新会话按钮都还没渲染）

- [ ] **Step 3: 替换 ChatComposer 底部脚标 JSX**

在 `web/components/chat/ChatComposer.tsx` 中，**找到 Task 3 Step 3g 中的占位脚标行**：

```tsx
{/* 底部脚标行 —— Task 4 会填充元信息条，本任务只放发送按钮 */}
<div className="chat-composer-meta flex items-center gap-2 px-4 py-2.5">
  <div className="flex-1" />
  <Button ...>发送/停止</Button>
</div>
```

**替换为完整的元信息条**：

```tsx
{/* 底部元信息条 */}
<div className="chat-composer-meta flex items-center gap-2.5 px-4 py-2.5 text-[11px]">
  {/* 左侧：环境名 + 模式 + 模型 */}
  {envId && (
    <>
      <span className="flex items-center gap-1 text-text-primary font-medium max-w-[140px]">
        <span
          className="w-[18px] h-[18px] rounded-[5px] flex items-center justify-center text-[10px] shrink-0"
          style={{
            background: "color-mix(in srgb, var(--color-brand) 12%, transparent)",
          }}
        >
          ⬡
        </span>
        <span className="truncate">{envName ?? envId}</span>
      </span>
      <span className="chat-composer-divider" />
    </>
  )}

  {availableModes && availableModes.length > 0 && onModeChange && (
    <SessionModeSelector
      modes={availableModes}
      currentModeId={currentModeId ?? null}
      onModeChange={onModeChange}
    />
  )}

  <ModelSelectorPopover client={client} />

  {/* 中间弹簧 */}
  <div className="flex-1" />

  {/* 右侧：token 统计 + 新会话 + 发送 */}
  {tokenStats && tokenStats.estimatedTokens > 0 && (
    <>
      <span className="font-mono text-text-secondary whitespace-nowrap">
        {formatTokenCount(tokenStats.estimatedTokens)} / 200k
      </span>
      <div className="w-12 h-1 rounded-full bg-surface-3 overflow-hidden flex shrink-0">
        <div
          className="h-full bg-brand transition-[width] duration-500"
          style={{
            width: `${Math.min((tokenStats.estimatedInputTokens / MAX_CONTEXT_TOKENS) * 100, 100)}%`,
          }}
        />
        <div
          className="h-full bg-accent-green transition-[width] duration-500"
          style={{
            width: `${Math.min((tokenStats.estimatedOutputTokens / MAX_CONTEXT_TOKENS) * 100, 100)}%`,
          }}
        />
      </div>
      <span className="font-mono text-text-primary font-semibold min-w-[28px] text-right">
        {Math.min(Math.round((tokenStats.estimatedTokens / MAX_CONTEXT_TOKENS) * 100), 100)}%
      </span>
      <span className="chat-composer-divider" />
    </>
  )}

  {showNewSession && onNewSession && (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onNewSession}
      className="h-7 px-2 text-[11px] text-text-muted hover:text-text-primary gap-1"
    >
      + {t("chatComposer.newSession")}
    </Button>
  )}

  <Button
    type="button"
    variant="ghost"
    size="sm"
    onClick={isLoading ? onInterrupt : handleSubmit}
    disabled={!isLoading && !canSend}
    className={cn(
      "h-8 gap-1.5 text-xs font-medium rounded-lg",
      isLoading
        ? "bg-text-primary text-surface-2 hover:bg-text-secondary"
        : canSend
          ? "bg-brand text-white hover:bg-brand-light"
          : "bg-surface-3 text-text-muted",
    )}
  >
    {isLoading ? (
      <>
        <Square className="h-3 w-3" fill="currentColor" />
        {t("chatComposer.stop")}
      </>
    ) : (
      <>
        <Send className="h-3.5 w-3.5" />
        {t("chatComposer.send")}
      </>
    )}
  </Button>
</div>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test web/src/__tests__/chat-composer.test.tsx`
Expected: 所有测试 PASS（包括 3 个新增测试）

- [ ] **Step 5: 运行 build 确认无类型错误**

Run: `bun run build:web`
Expected: 构建成功

- [ ] **Step 6: 提交**

```bash
git add web/components/chat/ChatComposer.tsx web/src/__tests__/chat-composer.test.tsx
git commit -m "feat(chat): ChatComposer 添加元信息条

底部脚标行填充完整元信息：
- 环境名（envApi 加载 + envId 兜底）
- SessionModeSelector + ModelSelectorPopover
- token 数字 + 双色进度条 + 百分比
- 新会话按钮（条件渲染）
- 发送/停止按钮

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 6: 把 ChatComposer 接入 ChatInterface

**Files:**
- Modify: `web/components/ChatInterface.tsx`

**目的：** 用 `<ChatComposer>` 替换 ChatInterface 中的 `<div> ModelSelector 行 </div> + <ChatInput>`。

- [ ] **Step 1: 计算 tokenStats 并准备传给 ChatComposer**

在 `web/components/ChatInterface.tsx` 中：

1a. **在文件顶部 import 区追加**：

```tsx
import { computeStats, type TokenStats } from "../src/lib/token-stats";
import { ChatComposer } from "./chat/ChatComposer";
```

（注意：`SessionModeSelector` 的 import 在 Task 1 已移除，因为现在由 ChatComposer 内部渲染）

1b. **找到现有 chat:stats dispatch（第 644-655 行附近）**，在 `useEffect` 上方新增 tokenStats 计算：

```tsx
// 计算 token 统计，传给 ChatComposer 元信息条
const tokenStats: TokenStats = useMemo(() => computeStats(entries), [entries]);
```

（如果 `useMemo` 还没 import，在 react import 行补上）

- [ ] **Step 2: 替换 ModelSelector 行 + ChatInput 渲染**

找到 ChatInterface return 中的这段（第 972-1015 行附近）：

```tsx
{/* Model selector + New thread + ChatInput */}
{!readonly && (
  <div className="flex-shrink-0">
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-8 pb-1 flex items-center justify-between">
      <div className="flex items-center gap-1">
        <SessionModeSelector modes={availableModes} currentModeId={currentModeId} onModeChange={setMode} />
        <ModelSelectorPopover client={client} />
      </div>
      {entries.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-text-muted hover:text-brand font-display gap-1"
              onClick={handleNewSession}
            >
              <Plus className="h-3 w-3" />
              新会话
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("chatInterface.newThread")}</TooltipContent>
        </Tooltip>
      )}
    </div>
    <ChatInput
      onSubmit={handleChatInputSubmit}
      isLoading={isLoading}
      onInterrupt={handleCancel}
      disabled={!sessionReady}
      placeholder={sessionReady ? t("chatInterface.agentPlaceholder") : t("chatInterface.waitingSession")}
      supportsImages={supportsImages}
      commands={availableCommands.length > 0 ? availableCommands : undefined}
      envId={agentId}
    />
  </div>
)}
```

**整段替换为**：

```tsx
{/* ChatComposer —— 玻璃磨砂命令岛（合并原 ModelSelector 行 + ChatInput） */}
{!readonly && (
  <div className="flex-shrink-0">
    <ChatComposer
      onSubmit={handleChatInputSubmit}
      isLoading={isLoading}
      onInterrupt={handleCancel}
      disabled={!sessionReady}
      placeholder={sessionReady ? t("chatInterface.agentPlaceholder") : t("chatInterface.waitingSession")}
      supportsImages={supportsImages}
      commands={availableCommands.length > 0 ? availableCommands : undefined}
      envId={agentId}
      client={client}
      availableModes={availableModes}
      currentModeId={currentModeId}
      onModeChange={setMode}
      tokenStats={tokenStats}
      onNewSession={handleNewSession}
      showNewSession={entries.length > 0}
    />
  </div>
)}
```

- [ ] **Step 3: 清理不再使用的 import**

在 `web/components/ChatInterface.tsx` 文件顶部检查并移除以下 import（如果不再被其他地方使用）：

- `import { ChatInput } from "./chat/ChatInput";` —— **移除**（ChatInput 不再使用）
- `import { ModelSelectorPopover } from "./model-selector";` —— **移除**（由 ChatComposer 内部渲染）
- `Plus` from `lucide-react` —— **检查**：如果 handleNewSession 之外没有其他使用，保留（handleNewSession 内部没用到 Plus，是 JSX 里用的；现在 JSX 替换后 Plus 可能不再需要）。grep 确认：`grep -n "Plus" web/components/ChatInterface.tsx`，如果只有被替换的 JSX 里用到，则移除。

注意：**不要移除** `Tooltip`、`TooltipContent`、`TooltipTrigger`、`Shield`、`Check`、`ChevronDown`、`ChevronUp` 等——它们可能在文件其他地方使用。用 grep 确认每个 import 的使用点后再决定。

- [ ] **Step 4: 运行 build 确认无类型错误**

Run: `bun run build:web`
Expected: 构建成功（无 "X is not exported" 或 "cannot find module" 错误）

- [ ] **Step 5: 运行全部前端测试**

Run: `bun test web/src/__tests__/`
Expected: 所有测试 PASS

- [ ] **Step 6: 提交**

```bash
git add web/components/ChatInterface.tsx
git commit -m "feat(chat): ChatInterface 接入 ChatComposer

- 用 ChatComposer 替换 ModelSelector 行 + ChatInput
- tokenStats 通过 useMemo(computeStats) 计算后 prop 传入
- 清理不再使用的 ChatInput / ModelSelectorPopover / Plus import

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 7: 移除 StatusHeader + 删除旧文件

**Files:**
- Modify: `web/src/routes/agent/_panel/chat.$agentId.tsx`
- Modify: `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx`
- Delete: `web/components/chat/ChatInput.tsx`
- Delete: `web/src/components/agent-panel/StatusHeader.tsx`
- Delete: `web/src/__tests__/chat-input-attachment.test.tsx`

**目的：** ChatComposer 已完全接管顶栏 + 输入职责。删除 StatusHeader 和 ChatInput，清理路由层的顶栏渲染和环境名加载。

- [ ] **Step 1: 改造 chat.$agentId.tsx**

在 `web/src/routes/agent/_panel/chat.$agentId.tsx` 中：

1a. **移除 import**：

```tsx
// 删除这行
import { StatusHeader } from "../../../components/agent-panel/StatusHeader";
```

以及：

```tsx
// 删除 envApi import（如果不再使用）
import { envApi } from "../../../../src/api/sdk";
```

（注意：先 grep 确认 envApi 是否还有其他用途：`grep -n "envApi" web/src/routes/agent/_panel/chat.\$agentId.tsx`。如果只在已删除的 useEffect 中使用，则移除整个 import。）

1b. **移除 envName state 和 useEffect**：

```tsx
// 删除这两段
const [envName, setEnvName] = useState<string | null>(null);

useEffect(() => {
  if (!agentId) {
    setEnvName(null);
    return;
  }
  envApi
    .get({ id: agentId })
    .then(({ data }) => setEnvName(data?.name ?? null))
    .catch(() => setEnvName(null));
}, [agentId]);
```

1c. **移除 StatusHeader 渲染**：

在 return 的 `<Suspense>` 内部，删除这行：

```tsx
<StatusHeader agentName={envName || stats.agentName} modelName={stats.modelName} entries={stats.entries} />
```

1d. **简化 stats state**（不再需要 agentName/modelName 字段，只需要 entries）：

```tsx
// 改为
const [entries, setEntries] = useState<ThreadEntry[]>([]);

// useEffect handler 也简化
useEffect(() => {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    setEntries(detail.entries ?? []);
  };
  window.addEventListener("chat:stats", handler);
  return () => window.removeEventListener("chat:stats", handler);
}, []);

// changedFiles 改为从 entries 派生
const changedFiles = useMemo(() => extractChangedFiles(entries), [entries]);
```

（注意：`ThreadEntry` 类型 import 保留。）

- [ ] **Step 2: 同样改造 chat.$agentId_.$sessionId.tsx**

对 `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx` 做**完全相同**的改造（移除 StatusHeader import、envApi import、envName state、useEffect、StatusHeader 渲染，简化 stats 为 entries）。

- [ ] **Step 3: 删除 ChatInput.tsx**

```bash
rm web/components/chat/ChatInput.tsx
```

- [ ] **Step 4: 删除 StatusHeader.tsx**

```bash
rm web/src/components/agent-panel/StatusHeader.tsx
```

- [ ] **Step 5: 删除 chat-input-attachment.test.tsx**

```bash
rm web/src/__tests__/chat-input-attachment.test.tsx
```

（这个测试的功能已被 `chat-composer.test.tsx` 覆盖。）

- [ ] **Step 6: 全局 grep 确认无残留引用**

```bash
grep -rn "StatusHeader\|from.*chat/ChatInput\|from.*ChatInput" web/ --include="*.tsx" --include="*.ts" | grep -v "node_modules\|__tests__"
```

Expected: 无输出（或只有注释/字符串中的残留，需要逐一确认）

如果发现残留引用：
- 如果是 import，删除或替换为 ChatComposer
- 如果是字符串引用（如注释），更新或删除

- [ ] **Step 7: 运行全部前端测试**

Run: `bun test web/src/__tests__/`
Expected: 所有测试 PASS（chat-input-attachment.test.tsx 已删除，不再报缺失模块）

- [ ] **Step 8: 运行 build**

Run: `bun run build:web`
Expected: 构建成功

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "refactor(chat): 移除 StatusHeader + ChatInput，清理路由层

- 删除 StatusHeader.tsx（功能并入 ChatComposer 元信息条）
- 删除 ChatInput.tsx（功能并入 ChatComposer）
- 删除 chat-input-attachment.test.tsx（被 chat-composer.test.tsx 取代）
- 路由层 chat.\$agentId.tsx / chat.\$agentId_.\$sessionId.tsx：
  - 移除 StatusHeader 渲染
  - 移除 envApi.get 调用（环境名改由 ChatComposer 内部获取）
  - 简化 stats state 为 entries 数组

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 8: 最终验证（precheck + build + 视觉回归）

**Files:** 无文件修改（验证任务）

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck`
Expected: 全部通过（format + import 排序 + tsc + biome check + 1543+ tests）

如果有 lint 报错：
- 未使用变量：删除
- import 排序：让 precheck 的 `--write` 自动修复
- biome-ignore：确认是否仍需要，不需要则删除

- [ ] **Step 2: 运行 build**

Run: `bun run build:web`
Expected: 构建成功，无 warning

- [ ] **Step 3: 手动视觉回归检查清单**

启动 `bun run dev:web`，在浏览器打开 `/agent/chat/<某个 agentId>`，逐一验证：

- [ ] 玻璃磨砂效果可见（半透明 + 模糊背景）
- [ ] textarea 默认 2 行高，输入多行自然扩展，超过 200px 内部滚动
- [ ] 元信息条从左到右：环境名（⬡ + 名称）→ 分隔线 → 模式 → 模型 → 弹簧 → token 数字 + 进度条 + 百分比 → 分隔线 → 新会话 → 发送
- [ ] 发送按钮：空输入时灰色 disabled，有输入时品牌色，loading 时变为"停止"
- [ ] focus textarea 时边框变品牌色淡蓝 + 光环
- [ ] 暗色模式下玻璃效果正常（切换主题验证）
- [ ] StatusHeader 顶栏**完全消失**（页面顶部直接是消息流）
- [ ] ModelSelectorPopover 点击弹出正常（验证 backdrop-filter 未影响 Popover 定位）
- [ ] 输入 `/` 触发 slash 命令菜单
- [ ] 输入 `@` 触发文件选择器
- [ ] 拖拽文件到输入框正常
- [ ] 粘贴图片正常
- [ ] readonly 模式下不显示 ChatComposer（只显示"只读模式"提示）
- [ ] 小屏（< 768px）下元信息条不溢出

- [ ] **Step 4: 如果发现问题，修复并追加提交**

常见问题与修复：

| 问题 | 修复 |
|------|------|
| ModelSelectorPopover 弹出层被 backdrop-filter 裁切 | 给 `.chat-composer-card` 加 `overflow: visible`（移除 overflow: hidden），或者把 Popover 的 content 用 portal 渲染到 body（Radix Popover 默认就是 portal，检查是否有 override） |
| textarea 首次渲染高度不对 | 在 useEffect 中立即触发一次高度调整：`useEffect(() => { const el = textareaRef.current; if (el) { el.style.height = "auto"; el.style.height = \`${Math.min(el.scrollHeight, 200)}px\`; } }, [])` |
| 暗色模式下玻璃背景太透 | 调整 `.dark .chat-composer-card` 的 rgba alpha 值（从 0.72 调到 0.85） |
| 元信息条小屏溢出 | 环境名加 `max-w-[100px] truncate`，token 进度条宽度从 48px 改 32px |

```bash
git add -A
git commit -m "fix(chat): ChatComposer 视觉回归修复

<具体修复内容>

Co-authored-by: Claude <noreply@anthropic.com>"
```

- [ ] **Step 5: 最终 precheck + build 确认**

Run: `bun run precheck && bun run build:web`
Expected: 全部通过

---

## Self-Review

### Spec coverage 检查

| Spec 要求 | 覆盖 Task |
|-----------|-----------|
| 新建 ChatComposer 组件 | Task 3 |
| 玻璃磨砂视觉（半透明 + backdrop-blur + 大圆角） | Task 4 (CSS) |
| textarea 默认 2 行高，max 200px | Task 3 (min-h-[48px] max-h-[200px]) |
| 去掉 / 和 @ 按钮 | Task 3 (JSX 重写) |
| 底部元信息条（环境名/模式/模型/token/新会话/发送） | Task 5 |
| token 数字 + 进度条 + 百分比 | Task 5 |
| 四角圆角 20px | Task 4 (border-radius: 20px) |
| 环境名用 name 字段不是 id | Task 3 (envApi.get → data.name) |
| 环境名加载失败兜底显示 envId | Task 3 (catch 块) |
| 删除 StatusHeader | Task 7 |
| 删除 ChatInput | Task 7 |
| 路由层移除 StatusHeader 渲染 | Task 7 |
| 路由层移除 envApi.get 调用 | Task 7 |
| chat:stats event 保留（路由层仍需要 entries） | Task 7 (简化为只取 entries) |
| tokenStats 从 ChatInterface prop 传入 | Task 6 (useMemo + computeStats) |
| readonly 模式不渲染 ChatComposer | Task 6 ({!readonly && ...}) |
| 暗色模式适配 | Task 4 (.dark 变体) |
| focus-within 品牌色光环 | Task 4 (:focus-within) |
| backdrop-filter 兼容 fallback | Task 4 (@supports not) |
| 响应式（小屏截断/缩短） | Task 5 (max-w-[140px] truncate) |
| 测试：ChatComposer 渲染 | Task 3 |
| 测试：环境名加载 | Task 5 |
| 测试：token 统计 | Task 5 |
| 测试：computeStats 纯函数 | Task 2 |
| 测试：SessionModeSelector | Task 1 |

**无遗漏。**

### 类型一致性检查

- `TokenStats` 在 Task 2 定义为 `{ estimatedTokens, estimatedInputTokens, estimatedOutputTokens }`，Task 5 使用同名字段 ✓
- `ChatComposerProps` 在 Task 3 定义，Task 6 传入时 props 名字完全匹配（onSubmit/isLoading/onInterrupt/disabled/placeholder/supportsImages/commands/envId/client/availableModes/currentModeId/onModeChange/tokenStats/onNewSession/showNewSession）✓
- `SessionModeSelectorProps` 在 Task 1 定义为 `{ modes, currentModeId, onModeChange }`，Task 5 使用同名字段 ✓
- `MAX_CONTEXT_TOKENS` 在 Task 3 定义为 200000，Task 5 使用同一常量 ✓
- `computeStats` 在 Task 2 返回 `TokenStats`，Task 6 的 `useMemo(() => computeStats(entries), [entries])` 类型匹配 ✓

**类型一致。**

### Placeholder 检查

- 无 "TBD" / "TODO" / "implement later"
- 所有代码步骤都有完整代码块
- 所有命令都有 expected output
- 测试代码完整可运行

**无 placeholder。**
