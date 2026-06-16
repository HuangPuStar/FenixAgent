# Chat 输入框重设计：玻璃磨砂命令岛

**日期**：2026-06-12
**状态**：待实现
**作者**：KonghaYao + Claude（brainstorming session）

## 背景与目标

当前 `/agent/chat/$agentId` 页面的"顶部信息"分散在两个位置：

- **顶栏 A · StatusHeader** —— 路由层 `chat.$agentId.tsx` 渲染的整宽浮动卡片，展示环境名、模型名、在线状态、Token 用量条
- **顶栏 B · ModelSelector 行** —— `ChatInterface` 内部紧贴输入框上方的一行，展示会话模式、模型选择器、新会话按钮
- **ChatInput** —— 底部独立的浮动卡片，承担输入职责

三者视觉割裂、信息冗余、占用纵向空间过多。本次重设计的核心目标是：

1. **三合一**：把顶栏 A + 顶栏 B + ChatInput 整合成单一的"命令岛"组件（`ChatComposer`），一张卡片覆盖所有信息
2. **轻薄灵动**：采用玻璃磨砂视觉（半透明 + backdrop-blur + 大圆角 + 柔和阴影），让命令岛"漂浮"在画布上
3. **编辑区够大**：textarea 默认 2 行高，自然扩展，告别扁长条
4. **去掉 / 和 @ 按钮**：textarea 直接接收输入，敲 `/` 仍触发命令菜单，敲 `@` 仍触发文件引用，拖拽仍可用

## 修改范围

### In Scope

| 组件 | 路径 | 改动 |
|------|------|------|
| 新建 ChatComposer | `web/components/chat/ChatComposer.tsx` | 新组件，取代 ChatInput + 顶栏 B 的职责 |
| ChatInterface | `web/components/ChatInterface.tsx` | 移除 ModelSelector 行 + `<ChatInput>`，改为渲染 `<ChatComposer>` |
| 删除 StatusHeader | `web/src/components/agent-panel/StatusHeader.tsx` | 整文件删除 |
| chat.$agentId 路由 | `web/src/routes/agent/_panel/chat.$agentId.tsx` | 移除 `<StatusHeader>` 渲染、移除 `envApi.get()` 调用 |
| chat.$agentId_.$sessionId 路由 | `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx` | 同上 |
| 删除 ChatInput | `web/components/chat/ChatInput.tsx` | 整文件删除（功能并入 ChatComposer） |
| i18n | `web/src/i18n/locales/{en,zh}/components.json` | 新增 ChatComposer 相关键值（"发送"/"停止"/"新会话" 已存在则复用） |

### Out of Scope（明确不动）

- **`AgentSidebar`**（外层左侧栏）—— 完全保持现状
- **`ACPMain` 的 Session List sidebar** —— 保持上一轮呼吸感重设计的浮动圆角卡片样式
- **`ArtifactsPanel`** —— 完全保持现状
- **消息流渲染逻辑**（`ChatView`、工具调用卡片、reasoning 等）
- **ACP 协议客户端**（`client` 的 API 调用、session 管理、model state）
- **`chat:stats` window event 机制** —— 保留（路由层仍需要 entries 派生 changedFiles）

## DOM 层级变化

### 当前

```
chat.$agentId.tsx
├── <StatusHeader agentName modelName entries />        ← 顶栏 A（删除）
└── .agent-panel-content
    ├── .agent-chat-area
    │   └── ChatPanel → ACPMain → ChatInterface
    │       ├── 消息流
    │       ├── <div> SessionModeSelector + ModelSelectorPopover + 新会话 </div>  ← 顶栏 B（删除）
    │       └── <ChatInput />                            ← 旧输入框（删除）
    └── <ArtifactsPanel />
```

### 新

```
chat.$agentId.tsx
└── .agent-panel-content                                ← 移除 StatusHeader 渲染
    ├── .agent-chat-area
    │   └── ChatPanel → ACPMain → ChatInterface
    │       ├── 消息流
    │       └── <ChatComposer ...props />               ← 新统一组件
    │           ├── 玻璃磨砂大编辑区（textarea，默认 2 行）
    │           └── 内嵌底部元信息条
    │               ├── 环境名（⬡ + name）
    │               ├── 会话模式
    │               ├── 模型选择器（ModelSelectorPopover）
    │               ├── Token 数字 + 进度条 + 百分比
    │               ├── 新会话按钮
    │               └── 发送/停止按钮
    └── <ArtifactsPanel />
```

## 组件设计：ChatComposer

### 位置

`web/components/chat/ChatComposer.tsx`

### Props 接口

```ts
interface ChatComposerProps {
  /** 提交消息 */
  onSubmit: (message: ChatInputMessage) => void;
  /** Agent 运行中（按钮变停止） */
  isLoading?: boolean;
  /** 中断 */
  onInterrupt?: () => void;
  /** 禁用输入（session 未就绪） */
  disabled?: boolean;
  /** placeholder */
  placeholder?: string;
  /** 是否支持图片上传 */
  supportsImages?: boolean;
  /** slash 命令列表 */
  commands?: AvailableCommand[];
  /** 环境 ID（用于文件上传 + 取环境名） */
  envId?: string;
  /** 会话模式 */
  availableModes?: SessionMode[];
  currentModeId?: string;
  onModeChange?: (modeId: string) => void;
  /** ACP 客户端（ModelSelectorPopover 需要） */
  client: ACPClient;
  /** Token 统计（从 ChatInterface 的 stats 派生） */
  tokenStats?: { estimatedTokens: number; estimatedInputTokens: number; estimatedOutputTokens: number; maxContextTokens: number };
  /** 新会话回调 */
  onNewSession?: () => void;
  /** 是否显示新会话按钮（entries 为空时不显示） */
  showNewSession?: boolean;
  className?: string;
}
```

### 内部结构

```tsx
export function ChatComposer(props: ChatComposerProps) {
  // 1. 文本/图片/附件/命令菜单状态（沿用 ChatInput 现有逻辑）
  // 2. envApi.get({id: envId}) 获取环境名（useEffect + abort controller 防竞态）
  // 3. textarea 自适应高度（沿用 ChatInput 的 scrollHeight 监听）
  // 4. 图片压缩、文件拖拽、@ 引用监听（沿用 ChatInput 逻辑）

  return (
    <div className="chat-composer">
      {/* 玻璃磨砂容器 */}
      <div className="chat-composer-card">

        {/* 编辑区 */}
        <div className="chat-composer-editor">
          {/* 图片预览（有图片时显示） */}
          {/* textarea */}
          <textarea ... />
        </div>

        {/* 底部元信息条 */}
        <div className="chat-composer-meta">
          {/* 左：环境名 + 模式 + 模型 */}
          {/* 右：token + 新会话 + 发送 */}
        </div>
      </div>

      {/* Slash 命令菜单（浮动） */}
      {/* 文件选择器 Dialog */}
    </div>
  );
}
```

### 沿用 ChatInput 的逻辑

以下逻辑从 `ChatInput.tsx` 原样迁移到 `ChatComposer.tsx`：

- 图片压缩（`processImageFiles`、`IMAGE_COMPRESSION_OPTIONS`）
- 粘贴图片处理（`handlePaste`）
- 拖拽文件路径（`handleDrop`）
- 文件树引用事件监听（`file-tree:reference` event）
- textarea 自适应高度（`handleInput` 中的 `scrollHeight` 逻辑）
- slash 命令菜单触发（输入 `/` 时 `toggleCommandMenu`）
- @ 文件引用触发（输入 `@` 时打开 FilePicker）
- 键盘快捷键（Enter 发送、Shift+Enter 换行）

## 数据流变化

### 环境名（environment name）

**当前**：路由层 `chat.$agentId.tsx` 调用 `envApi.get({id: agentId})` → 存入 `envName` state → 传给 `<StatusHeader agentName={envName || stats.agentName}>`

**新**：`ChatComposer` 内部用 `envId` prop 调用 `envApi.get({id: envId})`，独立管理 `envName` state。

- 防竞态：用 `AbortController` + cleanup，文件切换时取消上一个请求
- 失败兜底：显示 `envId`（保留可识别性，不用 "—"，便于排查）
- **注意**：必须用 `environment.name` 字段，**不是 `environment.id`**

### agentName / modelName / token

**当前**：`ChatInterface` 内部 `computeStats(entries)` 算出 token 估算 → `window.dispatchEvent("chat:stats", {agentName, modelName, entries})` → 路由层接住 → 传给 `<StatusHeader>`

**新**：`ChatInterface` 算出 stats 后**直接 prop 传给 `<ChatComposer tokenStats={...} />`**，不再走 window event 给 StatusHeader。

但 `chat:stats` event **保留**，因为路由层仍需要 `entries` 派生 `changedFiles` 给 `ArtifactsPanel`：

```tsx
// ChatInterface 内部
useEffect(() => {
  const stats = computeStats(entries);
  setLocalStats(stats); // 本地 state，传给 ChatComposer
  window.dispatchEvent(new CustomEvent("chat:stats", { detail: { entries } })); // 只广播 entries
}, [entries]);
```

### 模型选择器

**当前**：`<ModelSelectorPopover client={client} />` 渲染在 ChatInterface 的 ModelSelector 行

**新**：渲染在 `ChatComposer` 的元信息条内，`client` 通过 prop 传入。

## 视觉规格

### 玻璃磨砂容器

```css
.chat-composer-card {
  /* light */
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 20px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
}

/* dark */
.dark .chat-composer-card {
  background: rgba(45, 45, 47, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

/* focus-within */
.chat-composer-card:focus-within {
  border-color: color-mix(in srgb, var(--color-brand) 40%, transparent);
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--color-brand) 12%, transparent),
    0 4px 20px rgba(0, 0, 0, 0.06);
}
```

### 编辑区（textarea）

```css
.chat-composer-editor {
  padding: 16px 18px 8px;
}

.chat-composer-editor textarea {
  width: 100%;
  min-height: 48px;       /* 默认 2 行高 */
  max-height: 200px;      /* 超过后内部滚动 */
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-text-primary);
}

.chat-composer-editor textarea::placeholder {
  color: var(--color-text-tertiary);
}
```

自适应高度逻辑（沿用 ChatInput）：

```ts
useEffect(() => {
  const el = textareaRef.current;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}, [text]);
```

### 底部元信息条

```css
.chat-composer-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 12px;
  border-top: 1px solid rgba(0, 0, 0, 0.05); /* light */
  font-size: 11px;
}

.dark .chat-composer-meta {
  border-top-color: rgba(255, 255, 255, 0.05);
}

.chat-composer-meta .divider {
  width: 1px;
  height: 12px;
  background: rgba(0, 0, 0, 0.08);
}

.dark .chat-composer-meta .divider {
  background: rgba(255, 255, 255, 0.08);
}
```

### 元素形态

- **环境名**：⬡ 图标（18×18，`background: color-mix(in srgb, var(--color-brand) 12%, transparent)`，圆角 5px）+ 名称（`font-weight: 500`，截断 ellipsis）
- **模式按钮**：透明背景 + hover 浅填充（`background: rgba(0,0,0,0.04)`）
- **模型按钮**：同上，带 ▾ 下拉箭头（由 `ModelSelectorPopover` 渲染）
- **token 数字**：`12.3k / 200k`，`font-family: ui-monospace, monospace`，`color: var(--color-text-secondary)`
- **token 进度条**：`width: 48px; height: 4px; border-radius: 2px`，双色填充
  - 输入 token：`background: var(--color-brand)`
  - 输出 token：`background: var(--color-accent-green)`
- **百分比**：`font-mono, color: var(--color-text-primary), font-weight: 600`
- **新会话按钮**：透明背景，hover 浅填充
- **发送按钮**：胶囊形态，`padding: 6px 14px`，`background: var(--color-brand)`，`color: white`，`border-radius: 8px`，"↑ 发送" 图标 + 文字
  - loading 时：变为 "■ 停止"，`background: var(--color-text-primary)`
  - disabled：`background: var(--color-surface-3)`，`color: var(--color-text-muted)`

### 图片预览（有图片时）

沿用 ChatInput 的图片预览布局，渲染在编辑区上方（`padding-top: 12px`），网格排列，hover 显示删除按钮。

## readonly 模式

`ChatInterface` 原本有 readonly 分支，显示一行 "只读模式 — 无法发送消息"。

**新设计**：readonly 时**完全不渲染** `ChatComposer`，保留原来的单行提示。

```tsx
{!readonly && (
  <ChatComposer ...props />
)}
{readonly && (
  <div className="flex-shrink-0 px-4 py-3 text-center">
    <span className="text-xs text-text-muted">{t("chatInterface.readonlyMode")}</span>
  </div>
)}
```

## 响应式（< md 屏幕）

元信息条在小屏可能挤，策略：

- 环境名 `max-width: 120px` + `text-overflow: ellipsis`
- token 进度条宽度从 48px 缩到 32px
- 分隔线在小屏（`md:hidden`）隐藏，改用 gap 撑开
- 模式按钮在小屏只显示图标，不显示文字

## 测试策略

### 单元测试

`web/src/__tests__/chat-composer.test.tsx`：

- 渲染测试：默认 props 下渲染 textarea + 元信息条
- 环境名加载：mock `envApi.get` 返回 `{name: "测试环境"}`，断言渲染"测试环境"
- 环境名失败：mock `envApi.get` 失败，断言渲染 `envId`（兜底）
- token 进度条：传入 `tokenStats`，断言进度条宽度和百分比正确
- 发送按钮状态：`isLoading=true` 显示"停止"，`disabled=true` 灰色，默认显示"发送"
- slash 命令：输入 `/` 触发 `setShowCommandMenu(true)`
- 文件拖拽：模拟 drop 事件，断言 attachments 更新

### 迁移的测试

`web/src/__tests__/chat-input-attachment.test.tsx` 中关于 ChatInput 的测试，需要迁移到 ChatComposer（附件、拖拽、粘贴图片等逻辑不变，只是组件名变了）。

### 集成测试

`ChatInterface` 渲染 `ChatComposer` 而不是 `ChatInput` + ModelSelector 行：
- 断言只有一个 `chat-composer` 容器
- 断言 ModelSelectorPopover 在 `chat-composer-meta` 内部

### 移除的测试

`StatusHeader` 相关测试如果有，整文件移除（目前未发现专门的 StatusHeader 测试文件）。

## 涉及的文件清单

**新增**：

- `web/components/chat/ChatComposer.tsx`
- `web/src/__tests__/chat-composer.test.tsx`

**修改**：

- `web/components/ChatInterface.tsx` —— 移除 ModelSelector 行和 `<ChatInput>`，改为 `<ChatComposer>`
- `web/src/routes/agent/_panel/chat.$agentId.tsx` —— 移除 `<StatusHeader>` 渲染、移除 `envApi.get()` 调用、移除 `envName` state
- `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx` —— 同上
- `web/src/i18n/locales/zh/components.json` —— 新增 ChatComposer 相关键值（如 `chatComposer.send`、`chatComposer.stop` 等，已存在的复用）
- `web/src/i18n/locales/en/components.json` —— 同上
- `web/src/__tests__/chat-input-attachment.test.tsx` —— 迁移到 chat-composer 测试

**删除**：

- `web/components/chat/ChatInput.tsx`
- `web/src/components/agent-panel/StatusHeader.tsx`

## 风险与注意事项

### 1. 玻璃磨砂的浏览器兼容

`backdrop-filter` 在某些旧浏览器不支持，需要：

- 加 `-webkit-backdrop-filter` 前缀（Safari）
- fallback：不支持时退化为纯色背景（`@supports not (backdrop-filter: blur(16px))`）

### 2. textarea 自适应高度的初始值

默认 2 行高（`min-height: 48px`），但 `rows={1}` 属性会让浏览器先渲染 1 行再用 JS 拉伸。需要在首次 mount 时立即触发一次高度调整，避免闪烁。

### 3. ModelSelectorPopover 的位置变化

原本独立渲染在 ModelSelector 行，现在内嵌到 `chat-composer-meta` 内部。需要确认 `ModelSelectorPopover` 的弹出层（Popover content）定位是否受 `backdrop-filter` 影响——已知某些浏览器中 `backdrop-filter` 会创建新的 stacking context，可能影响子元素 fixed 定位。**如果 Popover 定位异常**，备选方案是给 `chat-composer-card` 加 `isolation: isolate` 或调整 z-index。

### 4. chat:stats event 的兼容

`ChatInterface` 内部 dispatch event 时仍然要包含 `entries` 字段（路由层 ArtifactsPanel 需要），但可以不再包含 `agentName`/`modelName`（路由层不再用）。为避免破坏其他可能的 listener，**保留原有 payload 结构**，只是路由层不再读取 `agentName`/`modelName`。

### 5. 暗色模式适配

所有玻璃参数都写了 `.dark` 变体，但需要在实际暗色主题下验证：

- backdrop-blur 在暗色下的可见性
- 半透明背景与暗色画布的对比度
- 边框高光白在暗色下是否过亮

### 6. 错误处理

`envApi.get` 失败时显示 `envId` 作为兜底，避免空白。控制台打印错误日志便于排查。

## 实施顺序建议

1. 新建 `ChatComposer.tsx`，从 `ChatInput.tsx` 迁移所有逻辑，加上元信息条
2. 改造 `ChatInterface.tsx`，替换 `<ChatInput>` + ModelSelector 行为 `<ChatComposer>`
3. 验证 ChatInterface 渲染正常（precheck + 手动测试）
4. 移除路由层 `<StatusHeader>` 渲染和 `envApi.get()` 调用
5. 删除 `StatusHeader.tsx` 和 `ChatInput.tsx`
6. 迁移测试，新增 ChatComposer 测试
7. `bun run precheck` + `bun run build:web` 验证
8. 手动视觉回归（玻璃效果、暗色模式、readonly、响应式）
