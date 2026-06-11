# Chat 变更文件展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ArtifactsPanel 文件树下方展示本次会话中 Agent 修改过的文件列表（纯前端，无后端改动）

**Architecture:** 从已有的 `chat:stats` CustomEvent 中获取 `entries`，用 `useMemo` 派生出 `changedFiles: string[]`，通过 props 传给 ArtifactsPanel，在文件树下方渲染新的 `ChangedFilesSection` 组件。

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, lucide-react, react-i18next

---

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `web/src/lib/extract-changed-files.ts` | 从 entries 提取变更文件路径的纯函数 |
| 新建 | `web/src/components/agent-panel/ChangedFilesSection.tsx` | 变更文件列表 UI 组件 |
| 修改 | `web/src/pages/agent-panel/ArtifactsPanel.tsx` | 新增 `changedFiles` prop，渲染 ChangedFilesSection |
| 修改 | `web/src/routes/agent/_panel/chat.$agentId.tsx` | 派生 changedFiles，传给 ArtifactsPanel |
| 修改 | `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx` | 同上 |
| 修改 | `web/src/i18n/locales/en/agentPanel.json` | 新增英文 i18n key |
| 修改 | `web/src/i18n/locales/zh/agentPanel.json` | 新增中文 i18n key |
| 新建 | `web/src/__tests__/extract-changed-files.test.ts` | 单元测试 |

---

## Task 1: 提取逻辑 + 单元测试

**Files:**
- Create: `web/src/lib/extract-changed-files.ts`
- Create: `web/src/__tests__/extract-changed-files.test.ts`

### 背景
`ThreadEntry` 类型定义在 `web/src/lib/types.ts`。
`ToolCallContent` 类型定义在 `web/src/acp/types.ts`（通过 `packages/acp-link/src/types.ts` re-export）。

关键类型（参考，不要修改这些文件）：
```ts
// web/src/lib/types.ts
export interface ToolCallData {
  id: string;
  title: string;
  content?: ToolCallContent[];
  rawInput?: Record<string, unknown>;
  subEntries?: ThreadEntry[];
}
export type ThreadEntry = UserMessageEntry | AssistantMessageEntry | ToolCallEntry | PlanDisplayEntry;

// packages/acp-link/src/types.ts — ToolCallContent 的三种形态之一：
// { type: "diff"; path: string; oldText?: string | null; newText: string }
```

- [ ] **Step 1: 写失败测试**

新建文件 `web/src/__tests__/extract-changed-files.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { extractChangedFiles } from "../lib/extract-changed-files";
import type { ThreadEntry } from "../lib/types";

describe("extractChangedFiles", () => {
  // 空 entries 返回空数组
  test("空 entries 返回空数组", () => {
    expect(extractChangedFiles([])).toEqual([]);
  });

  // 非 tool_call 条目忽略
  test("非 tool_call 条目被忽略", () => {
    const entries: ThreadEntry[] = [
      { type: "user_message", id: "1", content: "hello" },
      { type: "assistant_message", id: "2", chunks: [] },
    ];
    expect(extractChangedFiles(entries)).toEqual([]);
  });

  // diff content 优先提取路径
  test("从 content[].type===diff 提取路径", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc1",
          title: "Edit",
          status: "complete",
          content: [
            { type: "diff", path: "src/foo.ts", newText: "new" },
            { type: "diff", path: "src/bar.ts", newText: "new" },
          ],
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual(["src/bar.ts", "src/foo.ts"]);
  });

  // 工具名 edit/write 兜底，从 rawInput.file_path 提取
  test("工具名包含 edit 时从 rawInput.file_path 兜底提取", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc2",
          title: "str_replace_based_edit_tool",
          status: "complete",
          rawInput: { file_path: "src/utils.ts" },
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual(["src/utils.ts"]);
  });

  // 工具名包含 write，从 rawInput.path 提取
  test("工具名包含 write 时从 rawInput.path 兜底提取", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc3",
          title: "write_file",
          status: "complete",
          rawInput: { path: "src/new-file.ts" },
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual(["src/new-file.ts"]);
  });

  // bash 不提取
  test("bash 工具不提取路径", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc4",
          title: "Bash",
          status: "complete",
          rawInput: { command: "rm -rf src/foo.ts" },
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual([]);
  });

  // 去重
  test("相同路径去重", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc5",
          title: "Edit",
          status: "complete",
          content: [{ type: "diff", path: "src/foo.ts", newText: "v1" }],
        },
      },
      {
        type: "tool_call",
        toolCall: {
          id: "tc6",
          title: "Edit",
          status: "complete",
          content: [{ type: "diff", path: "src/foo.ts", newText: "v2" }],
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual(["src/foo.ts"]);
  });

  // 递归 subEntries
  test("递归处理 subEntries", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc7",
          title: "Task",
          status: "complete",
          subEntries: [
            {
              type: "tool_call",
              toolCall: {
                id: "tc8",
                title: "Edit",
                status: "complete",
                content: [{ type: "diff", path: "src/nested.ts", newText: "x" }],
              },
            },
          ],
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual(["src/nested.ts"]);
  });

  // 排序
  test("结果按字母序排序", () => {
    const entries: ThreadEntry[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "tc9",
          title: "Edit",
          status: "complete",
          content: [
            { type: "diff", path: "src/z.ts", newText: "" },
            { type: "diff", path: "src/a.ts", newText: "" },
            { type: "diff", path: "src/m.ts", newText: "" },
          ],
        },
      },
    ];
    expect(extractChangedFiles(entries)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
bun test web/src/__tests__/extract-changed-files.test.ts
```

期望：FAIL，报 `Cannot find module '../lib/extract-changed-files'`

- [ ] **Step 3: 实现提取函数**

新建文件 `web/src/lib/extract-changed-files.ts`：

```ts
import type { ThreadEntry, ToolCallData } from "./types";

/**
 * 从 chat entries 中提取被 Agent 修改过的文件路径列表。
 *
 * 提取优先级：
 * 1. tool_call.content[].type === "diff" 中的 path（最精准，agent 明确标记）
 * 2. 工具名 case-insensitive 包含 "edit"/"write" 或等于 "str_replace" 时，
 *    从 rawInput.file_path 或 rawInput.path 兜底提取
 * 3. bash 工具不提取（路径无法可靠解析）
 *
 * 递归处理 subEntries（子 agent 的变更也统计）。
 * 去重并按字母序排序后返回。
 */
export function extractChangedFiles(entries: ThreadEntry[]): string[] {
  const paths = new Set<string>();
  collectFromEntries(entries, paths);
  return Array.from(paths).sort();
}

/** 递归遍历 entries，将变更文件路径收集到 set 中 */
function collectFromEntries(entries: ThreadEntry[], paths: Set<string>): void {
  for (const entry of entries) {
    if (entry.type !== "tool_call") continue;
    collectFromToolCall(entry.toolCall, paths);
  }
}

/** 从单个工具调用中提取路径，并递归处理子 entries */
function collectFromToolCall(toolCall: ToolCallData, paths: Set<string>): void {
  // 优先：从 diff content 提取（最精准）
  if (toolCall.content && toolCall.content.length > 0) {
    let hasDiff = false;
    for (const c of toolCall.content) {
      if (c.type === "diff" && c.path) {
        paths.add(c.path);
        hasDiff = true;
      }
    }
    // 有 diff 数据时不再兜底，避免重复
    if (hasDiff) {
      // 仍然递归子 entries
      if (toolCall.subEntries) collectFromEntries(toolCall.subEntries, paths);
      return;
    }
  }

  // 兜底：按工具名推断（没有 diff content 时）
  const titleLower = toolCall.title.toLowerCase();
  const isWriteTool =
    titleLower.includes("edit") ||
    titleLower.includes("write") ||
    titleLower === "str_replace";

  if (isWriteTool && toolCall.rawInput) {
    // 尝试 file_path 字段（Edit 工具常用）
    const filePath = toolCall.rawInput.file_path;
    if (typeof filePath === "string" && filePath) {
      paths.add(filePath);
    } else {
      // 尝试 path 字段（Write 工具常用）
      const path = toolCall.rawInput.path;
      if (typeof path === "string" && path) {
        paths.add(path);
      }
    }
  }

  // 递归处理子 entries（子 agent 嵌套）
  if (toolCall.subEntries) {
    collectFromEntries(toolCall.subEntries, paths);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test web/src/__tests__/extract-changed-files.test.ts
```

期望：所有测试 PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
git add web/src/lib/extract-changed-files.ts web/src/__tests__/extract-changed-files.test.ts
git commit -m "feat(chat): 新增 extractChangedFiles 工具函数及单元测试

Co-Authored-By: claude-sonnet-4-6 <noreply@anthropic.com>"
```

---

## Task 2: i18n key

**Files:**
- Modify: `web/src/i18n/locales/en/agentPanel.json`
- Modify: `web/src/i18n/locales/zh/agentPanel.json`

- [ ] **Step 1: 添加英文 key**

在 `web/src/i18n/locales/en/agentPanel.json` 末尾的 `"memories": "Memories"` 之后加入（注意 JSON 格式，最后一个原有字段加逗号）：

```json
  "changedFiles": {
    "title": "Changed Files",
    "count_one": "{{count}} file",
    "count_other": "{{count}} files"
  }
```

完整末尾结构应为：
```json
  "memories": "Memories",
  "changedFiles": {
    "title": "Changed Files",
    "count_one": "{{count}} file",
    "count_other": "{{count}} files"
  }
}
```

- [ ] **Step 2: 添加中文 key**

在 `web/src/i18n/locales/zh/agentPanel.json` 末尾 `"memories": "记忆"` 之后加入：

```json
  "changedFiles": {
    "title": "变更文件",
    "count_one": "{{count}} 个文件",
    "count_other": "{{count}} 个文件"
  }
```

完整末尾结构应为：
```json
  "memories": "记忆",
  "changedFiles": {
    "title": "变更文件",
    "count_one": "{{count}} 个文件",
    "count_other": "{{count}} 个文件"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/locales/en/agentPanel.json web/src/i18n/locales/zh/agentPanel.json
git commit -m "feat(chat): 添加变更文件展示的 i18n key

Co-Authored-By: claude-sonnet-4-6 <noreply@anthropic.com>"
```

---

## Task 3: ChangedFilesSection 组件

**Files:**
- Create: `web/src/components/agent-panel/ChangedFilesSection.tsx`

### 背景
- 图标来源：`lucide-react`（项目唯一图标库）
- 样式参考：`ArtifactsPanel.tsx` 里标题行的 `text-xs text-text-primary flex items-center gap-1`
- i18n 命名空间：`NS.AGENT_PANEL`（从 `web/src/i18n/index.ts` 导入 `NS`）
- 无变更时返回 null，不渲染

- [ ] **Step 1: 创建组件**

新建文件 `web/src/components/agent-panel/ChangedFilesSection.tsx`：

```tsx
import { GitCommitHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../i18n";

interface ChangedFilesSectionProps {
  /** 变更文件路径列表，已去重排序 */
  files: string[];
}

/**
 * 在 ArtifactsPanel 文件树下方展示本次会话中被 Agent 修改的文件列表。
 * 只显示文件名，hover title 展示完整路径。
 * 无变更时不渲染（返回 null）。
 */
export function ChangedFilesSection({ files }: ChangedFilesSectionProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);

  // 没有变更文件时不渲染，保持界面简洁
  if (files.length === 0) return null;

  return (
    <div className="border-t border-border">
      {/* 标题行 */}
      <div className="flex items-center justify-between px-2 py-1.5 shrink-0">
        <span className="text-xs text-text-primary flex items-center gap-1">
          <GitCommitHorizontal className="h-3 w-3" />
          {t("changedFiles.title")}
        </span>
        {/* 文件数徽章 */}
        <span className="text-xs text-text-muted bg-surface-2 px-1.5 py-0.5 rounded-full leading-none">
          {t("changedFiles.count", { count: files.length })}
        </span>
      </div>

      {/* 文件列表 */}
      <ul className="pb-2">
        {files.map((filePath) => {
          const fileName = filePath.split("/").pop() ?? filePath;
          return (
            <li
              key={filePath}
              title={filePath}
              className="flex items-center gap-1.5 px-3 py-0.5 text-xs text-text-muted hover:bg-surface-2 cursor-default truncate"
            >
              {fileName}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: 确认 TypeScript 无报错**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
bun run precheck 2>&1 | head -40
```

期望：无 TS 错误（可能有格式差异，precheck 会自动修复格式）

- [ ] **Step 3: Commit**

```bash
git add web/src/components/agent-panel/ChangedFilesSection.tsx
git commit -m "feat(chat): 新增 ChangedFilesSection 组件

Co-Authored-By: claude-sonnet-4-6 <noreply@anthropic.com>"
```

---

## Task 4: 接入 ArtifactsPanel

**Files:**
- Modify: `web/src/pages/agent-panel/ArtifactsPanel.tsx`

### 背景
当前 `ArtifactsPanelProps`：
```ts
interface ArtifactsPanelProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  envId: string | null;
}
```

文件树渲染位置（`ArtifactsPanel.tsx:214`）：
```tsx
<div className="flex-1 min-h-0">
  <FileTreeTab
    ref={fileTreeRef}
    envId={envId}
    onPreviewFile={handlePreviewFile}
    onReferenceFile={handleReferenceFile}
  />
</div>
```

目标：在 `FileTreeTab` 下方紧接渲染 `ChangedFilesSection`，两者在同一 flex 容器内垂直排列。

- [ ] **Step 1: 修改 Props 接口，新增 changedFiles**

在 `web/src/pages/agent-panel/ArtifactsPanel.tsx` 中，找到：

```ts
interface ArtifactsPanelProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  envId: string | null;
}
```

替换为：

```ts
interface ArtifactsPanelProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  envId: string | null;
  /** 本次会话中被 Agent 修改的文件路径列表，已去重排序 */
  changedFiles?: string[];
}
```

- [ ] **Step 2: 解构新 prop，渲染 ChangedFilesSection**

在函数签名处，找到：

```ts
export function ArtifactsPanel({ collapsed, onToggleCollapse, envId }: ArtifactsPanelProps) {
```

替换为：

```ts
export function ArtifactsPanel({ collapsed, onToggleCollapse, envId, changedFiles = [] }: ArtifactsPanelProps) {
```

- [ ] **Step 3: 在文件树下方插入 ChangedFilesSection**

找到包裹 FileTreeTab 的 div：

```tsx
          <div className="flex-1 min-h-0">
            <FileTreeTab
              ref={fileTreeRef}
              envId={envId}
              onPreviewFile={handlePreviewFile}
              onReferenceFile={handleReferenceFile}
            />
          </div>
```

替换为：

```tsx
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex-1 min-h-0">
              <FileTreeTab
                ref={fileTreeRef}
                envId={envId}
                onPreviewFile={handlePreviewFile}
                onReferenceFile={handleReferenceFile}
              />
            </div>
            <ChangedFilesSection files={changedFiles} />
          </div>
```

- [ ] **Step 4: 添加 import**

在文件顶部的 import 区域，找到 FileTreeTab 的导入行：

```ts
import { FileTreeTab, type FileTreeTabHandle } from "../../components/agent-panel/FileTreeTab";
```

在其后一行添加：

```ts
import { ChangedFilesSection } from "../../components/agent-panel/ChangedFilesSection";
```

- [ ] **Step 5: 运行 precheck**

```bash
bun run precheck 2>&1 | tail -20
```

期望：无 TS 错误，格式自动修复

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/agent-panel/ArtifactsPanel.tsx
git commit -m "feat(chat): ArtifactsPanel 接入变更文件展示

Co-Authored-By: claude-sonnet-4-6 <noreply@anthropic.com>"
```

---

## Task 5: 路由层接入数据

**Files:**
- Modify: `web/src/routes/agent/_panel/chat.$agentId.tsx`
- Modify: `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx`

### 背景
两个路由文件结构几乎一致，都有：
```ts
const [stats, setStats] = useState<{ agentName?: string; modelName?: string; entries: ThreadEntry[] }>({
  entries: [],
});
```
并通过 `chat:stats` CustomEvent 更新。

`ArtifactsPanel` 在两个文件里都以相同方式渲染：
```tsx
<ArtifactsPanel
  collapsed={artifactsCollapsed}
  onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
  envId={agentId}
/>
```

- [ ] **Step 1: 修改 chat.$agentId.tsx**

在 `web/src/routes/agent/_panel/chat.$agentId.tsx` 中，找到现有 import：

```ts
import type { ThreadEntry } from "../../../../src/lib/types";
```

在其后加一行：

```ts
import { extractChangedFiles } from "../../../../src/lib/extract-changed-files";
```

然后在 `stats` state 定义之后（`useEffect` 之前），找到：

```ts
  const [stats, setStats] = useState<{ agentName?: string; modelName?: string; entries: ThreadEntry[] }>({
    entries: [],
  });
```

在其正下方添加（与 useState 同级，在第一个 useEffect 之前）：

```ts
  // 从 entries 派生变更文件列表，实时跟随对话更新
  const changedFiles = useMemo(() => extractChangedFiles(stats.entries), [stats.entries]);
```

注意：`useMemo` 已在文件头部从 react 导入（文件已有 `import { lazy, Suspense, useEffect, useState } from "react"`），需要补上 `useMemo`：

找到：
```ts
import { lazy, Suspense, useEffect, useState } from "react";
```

替换为：
```ts
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
```

最后，找到 ArtifactsPanel 的 JSX：

```tsx
        <ArtifactsPanel
          collapsed={artifactsCollapsed}
          onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
          envId={agentId}
        />
```

替换为：

```tsx
        <ArtifactsPanel
          collapsed={artifactsCollapsed}
          onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
          envId={agentId}
          changedFiles={changedFiles}
        />
```

- [ ] **Step 2: 修改 chat.$agentId_.$sessionId.tsx**

在 `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx` 中做相同改动：

找到：
```ts
import type { ThreadEntry } from "../../../../src/lib/types";
```
替换为：
```ts
import type { ThreadEntry } from "../../../../src/lib/types";
import { extractChangedFiles } from "../../../../src/lib/extract-changed-files";
```

找到：
```ts
import { lazy, Suspense, useEffect, useState } from "react";
```
替换为：
```ts
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
```

在 stats useState 之后添加：
```ts
  // 从 entries 派生变更文件列表，实时跟随对话更新
  const changedFiles = useMemo(() => extractChangedFiles(stats.entries), [stats.entries]);
```

找到 ArtifactsPanel JSX（该文件里 envId 用的也是 agentId）：
```tsx
        <ArtifactsPanel
          collapsed={artifactsCollapsed}
          onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
          envId={agentId}
        />
```
替换为：
```tsx
        <ArtifactsPanel
          collapsed={artifactsCollapsed}
          onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
          envId={agentId}
          changedFiles={changedFiles}
        />
```

- [ ] **Step 3: 运行全量测试 + precheck**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
bun run precheck 2>&1 | tail -20
bun test web/src/__tests__/extract-changed-files.test.ts
```

期望：precheck 通过，测试全 PASS

- [ ] **Step 4: 构建前端**

```bash
bun run build:web 2>&1 | tail -20
```

期望：build 成功，无报错

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/agent/_panel/chat.\$agentId.tsx \
        web/src/routes/agent/_panel/chat.\$agentId_.\$sessionId.tsx
git commit -m "feat(chat): 路由层接入变更文件数据，传递给 ArtifactsPanel

Co-Authored-By: claude-sonnet-4-6 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage 检查：**
- ✅ 数据提取逻辑（diff 优先 + 工具名兜底）→ Task 1
- ✅ 递归 subEntries → Task 1
- ✅ 去重排序 → Task 1
- ✅ i18n 双语 → Task 2
- ✅ ChangedFilesSection 组件（文件名 + tooltip + 徽章）→ Task 3
- ✅ 无变更时不渲染 → Task 3
- ✅ ArtifactsPanel 接入 → Task 4
- ✅ 两个路由文件都接入 → Task 5
- ✅ 构建验证 → Task 5

**Placeholder 扫描：** 无 TBD/TODO

**Type consistency：**
- `extractChangedFiles(entries: ThreadEntry[]): string[]` 在 Task 1 定义，Task 5 使用 ✅
- `ArtifactsPanelProps.changedFiles?: string[]` 在 Task 4 定义，Task 5 传值 ✅
- `ChangedFilesSectionProps.files: string[]` 在 Task 3 定义，Task 4 使用 ✅
