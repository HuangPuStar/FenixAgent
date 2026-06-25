# AgentSites Card 测试指南

分支 `feature/chat-tag`，已实现：
- 全局卡片渲染注册架构（`web/src/lib/card-renderer/`）
- `AgentSitesCard` 组件 — 根据后端 site ID 渲染站点卡片

## 架构

```
LLM 输出 <agent-sites agent-site-id="app-xxxx"/>
   → streamdown 渲染 AgentSitesCard
   → 卡片挂载时调 agentSitesApi.get(id) 查站点名称
   → 显示站点卡片（名称 + ID）
   → 用户点击卡片
   → dispatch artifacts:select-site CustomEvent
   → ArtifactsPanel 切换到 Sites 模式，选中对应 site
   → SiteFrame 加载 /{remoteAppId}/
```

## 测试步骤

### 1. 确保有已绑定的 site

在某个 Agent 的 Agent 配置页面（`/agent/config/agents`），确认该 Agent 至少绑定了一个 Agent Site。如果没有，需要先挂载一个。

### 2. 获取 site ID

在 ArtifactsPanel 切换到 Sites tab，打开浏览器 DevTools Network 面板，找一个 site，记下它的 ID（形如 `app-xxxx`）。

### 3. 在聊天中触发卡片渲染

在对应 Agent 的聊天中输入：

```
<agent-sites agent-site-id="app-xxxx"/>
```

**预期**：
- 不显示为纯文本 `<agent-sites ...>`
- 先短暂显示 loading（旋转图标 + "加载中…"）
- 然后显示卡片：左侧 Globe 图标 + 站点名称 + site ID 副文本

### 4. 点击卡片

**预期**：
- 右侧 ArtifactsPanel 自动切到 Sites 模式
- 该 site 被选中（tab 高亮）
- 下方 iframe 加载站点内容

### 5. 回归测试

- 普通 markdown 消息（无自定义标签）正常流式渲染
- 代码块、表格、图片等非自定义标签不受影响
- ArtifactsPanel Files 模式功能正常

## 文件清单

| 文件 | 作用 |
|------|------|
| `web/src/lib/card-renderer/emitter.ts` | 轻量事件发射器 |
| `web/src/lib/card-renderer/context.tsx` | MessageEmitterContext + useCardEmit |
| `web/src/lib/card-renderer/registry.ts` | 全局注册表 |
| `web/src/lib/card-renderer/index.ts` | Barrel export |
| `web/src/lib/card-renderer/builtins.ts` | 注册内置卡片（agent-sites → AgentSitesCard） |
| `web/src/components/agent-panel/AgentSitesCard.tsx` | 站点卡片组件（Loading/Error/Success 三态） |
| `web/components/chat/MessageBubble.tsx` | 挂 MessageEmitterContext.Provider |
| `web/components/ai-elements/message.tsx` | 合并注册表到 streamdown |
| `web/src/pages/agent-panel/ArtifactsPanel.tsx` | 监听 artifacts:select-site 事件 |
| `web/src/main.tsx` | 导入 builtins |

## 已知限制

- 流式截断的标签（`<agent-si`）不会渲染为卡片，而是显示为纯文本（streamdown 不认识自定义标签的不完整形式）
- 如果传入的 site ID 不存在，卡片显示 "Unknown Site"（不阻塞聊天）
- API 请求失败时显示红色错误卡片，但仍可点击
