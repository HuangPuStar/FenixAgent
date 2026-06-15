# Chat 变更文件展示功能设计

**日期**：2026-06-11  
**状态**：已批准  
**作用域**：前端纯展示，无后端改动

---

## 背景

Agent 在执行任务时会调用 edit/write 等工具修改文件，当前聊天界面仅在工具调用折叠行里展示工具名，无法一目了然地知道本次对话改动了哪些文件。

ACP 协议的 `ToolCallContent` 已有 `type: "diff"` 字段携带 `path`/`oldText`/`newText`，数据已到达前端但未被利用。

---

## 目标

在 ArtifactsPanel（右侧栏）文件树下方，增加一个「变更文件」区块，实时展示本次会话中被 Agent 修改过的文件名列表。

**非目标**：
- 不展示 diff 内容
- 不实现点击跳转
- 不分轮次追踪（整个 session 累计）
- 无后端改动

---

## 架构

```
ChatRoute
  stats.entries (via chat:stats CustomEvent，已有)
    → useMemo → changedFiles: string[]   ← 新增派生
    → ArtifactsPanel (新增 changedFiles prop)
        ├── FileTreeTab（现有，不变）
        └── ChangedFilesSection（新增组件）
```

两个路由文件均需同步修改：
- `web/src/routes/agent/_panel/chat.$agentId.tsx`
- `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx`

---

## 数据提取逻辑

新文件：`web/src/lib/extract-changed-files.ts`

```
extractChangedFiles(entries: ThreadEntry[]): string[]
```

**优先级**（按精准度从高到低）：

1. **diff 信号**：`ToolCallContent.type === "diff"` → 取 `diff.path`（最精准，agent 明确标记了变更）
2. **工具名兜底**：工具名（case-insensitive）匹配以下规则时，从 `rawInput` 提取路径：
   - 工具名包含 `"edit"` 或 `"write"` → 取 `rawInput.file_path` 或 `rawInput.path`
   - 工具名等于 `"str_replace"` → 取 `rawInput.path`
   - `bash` 不提取（路径无法可靠解析）

**递归**：对每个 `tool_call` entry 递归处理 `toolCall.subEntries`（子 agent 的变更也统计）

**去重与排序**：用 `Set<string>` 去重，按字母序排序后返回 `string[]`

---

## 组件设计

### ChangedFilesSection

新文件：`web/src/components/agent-panel/ChangedFilesSection.tsx`

Props：
```ts
interface ChangedFilesSectionProps {
  files: string[];
}
```

UI 结构：
- 当 `files.length === 0` 时组件不渲染（`return null`）
- 标题行：`GitCommitHorizontal` 图标 + i18n 文案「变更文件」+ 文件数徽章（`files.length`）
- 列表：每行仅显示文件名（`path.split('/').pop()`），`title` 属性展示完整路径（tooltip）
- 样式与现有 FileTreeTab 的节点行保持一致（`text-xs`、`px-2`、`text-text-muted`）

### ArtifactsPanel 改动

- Props 新增 `changedFiles: string[]`（默认 `[]`）
- 在 `<FileTreeTab />` 之后紧跟渲染 `<ChangedFilesSection files={changedFiles} />`
- 两者之间加一条细分隔线 `border-t border-border`

---

## i18n

命名空间：`agentPanel`（`web/src/i18n/locales/{en,zh}/agentPanel.json`）

新增 key：
| key | 中文 | 英文 |
|-----|------|------|
| `changedFiles.title` | 变更文件 | Changed Files |
| `changedFiles.count` | `{{count}} 个文件` | `{{count}} files` |

---

## 数据流

```
ChatInterface.tsx
  dispatchEvent("chat:stats", { entries, ... })
    ↓
ChatRoute (chat.$agentId.tsx)
  const changedFiles = useMemo(() => extractChangedFiles(stats.entries), [stats.entries])
    ↓
ArtifactsPanel (changedFiles={changedFiles})
  ↓
ChangedFilesSection (files={changedFiles})
```

---

## 文件清单

| 操作 | 文件 |
|------|------|
| 新建 | `web/src/lib/extract-changed-files.ts` |
| 新建 | `web/src/components/agent-panel/ChangedFilesSection.tsx` |
| 修改 | `web/src/pages/agent-panel/ArtifactsPanel.tsx` |
| 修改 | `web/src/routes/agent/_panel/chat.$agentId.tsx` |
| 修改 | `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx` |
| 修改 | `web/src/i18n/locales/en/agentPanel.json` |
| 修改 | `web/src/i18n/locales/zh/agentPanel.json` |

---

## 测试要点

- `extractChangedFiles` 单元测试：diff 信号优先、工具名兜底、subEntries 递归、去重、空 entries 返回 `[]`
- 无变更时 `ChangedFilesSection` 不渲染
- 有变更时正确显示文件名和计数
