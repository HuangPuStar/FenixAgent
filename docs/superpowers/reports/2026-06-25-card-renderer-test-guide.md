# Card Renderer 测试指南

分支 `feature/chat-tag` 已合并以下功能：
1. 全局卡片渲染注册架构（`web/src/lib/card-renderer/`）
2. `AgentSitesCard` 组件 + 外部站点 iframe 支持

## 架构简述

```
LLM 输出 <agent-sites url="https://..." title="...">
   → streamdown 渲染 AgentSitesCard 卡片
   → 用户点击卡片
   → ArtifactsPanel 切换到 Sites 模式，打开 iframe
```

## 测试前准备

```bash
bun run build:web
bun run dev
```

## 测试步骤

### 1. 验证组件注册（无 LLM 场景，前端手动测试）

打开任意 Agent 聊天页面，在浏览器 Console 执行：

```js
// 验证注册表里有 agent-sites
import("/src/lib/card-renderer/registry.js").then(m => {
  console.log("已注册标签:", m.getRegisteredTags());
  // 应输出: ["agent-sites"]
  console.log("组件:", m.getRegisteredComponents());
  // 应输出: { "agent-sites": [Function: AgentSitesCard] }
});
```

### 2. 验证卡片渲染

让 LLM 输出包含 `<agent-sites>` 标签的内容。在聊天中输入：

```
请用下面的格式给我展示一个网站链接：

<agent-sites url="https://www.example.com" title="Example Site"/>
```

**预期效果**：
- 聊天消息中渲染一张带边框的卡片（而非纯文本 `<agent-sites>`）
- 卡片包含：左侧 Globe 圆形图标 + 右侧标题 "Example Site" + 下方 URL
- hover 时背景色变深

**如果显示纯文本**：说明注册未生效，检查 `web/src/main.tsx` 是否有 `import "./lib/card-renderer/builtins"`。

### 3. 验证点击事件

点击第 2 步渲染出的卡片。

**预期效果**：
- 右侧 ArtifactsPanel 自动切换到 "Sites" tab
- 显示顶栏（Globe 图标 + "Example Site" 标题 + × 关闭按钮）
- 下方 iframe 加载 `https://www.example.com`

**注意**：有些网站设置了 `X-Frame-Options: DENY` 会阻止在 iframe 中加载（显示空白/错误是正常行为，不是 bug）。测试时建议用允许 iframe 嵌入的网站，或者用一个 `/` 同源路径测试。

### 4. 验证关闭按钮

点击 ExternalSiteView 顶栏的 × 按钮。

**预期效果**：
- 外部站点 iframe 关闭
- ArtifactsPanel 回到原来的 Files 模式（或显示空 Sites 状态）

### 5. 验证多次点击

LLM 输出多个站点卡片：

```markdown
<agent-sites url="https://github.com" title="GitHub"/>

<agent-sites url="https://stackoverflow.com" title="Stack Overflow"/>
```

**预期效果**：
- 两张卡片分别渲染
- 点击第二张卡片，右侧切换到 Stack Overflow 的 iframe
- 两个卡片互相独立

### 6. 验证无 title 降级

```markdown
<agent-sites url="https://news.ycombinator.com"/>
```

**预期效果**：卡片标题显示 hostname（`news.ycombinator.com`）

### 7. 回归测试

- 普通 markdown 消息（无 `<agent-sites>` 标签）正常流式渲染
- 代码块、表格、图片等非自定义标签的渲染不受影响
- 思考过程 (`thought`) 块正常折叠
- ArtifactsPanel 的 Files 模式正常：文件预览、文件树、上传

## 已知限制

- 不处理流式截断（`<agent-si` 会被 streamdown/rehype-raw 当作文本处理，不会渲染为卡片）
- 外部站点 iframe 使用 `sandbox="allow-scripts allow-forms allow-popups allow-same-origin"`，`X-Frame-Options: DENY` 的网站无法嵌入
- 当前只支持 `agent-sites` 一个内置标签，其他标签需手动 `registerTagRenderer`

## 文件清单

| 文件 | 作用 |
|------|------|
| `web/src/lib/card-renderer/emitter.ts` | 轻量事件发射器 |
| `web/src/lib/card-renderer/context.tsx` | MessageEmitterContext + useCardEmit |
| `web/src/lib/card-renderer/registry.ts` | 全局注册表 |
| `web/src/lib/card-renderer/index.ts` | Barrel export |
| `web/src/lib/card-renderer/builtins.ts` | 注册内置卡片 |
| `web/src/components/agent-panel/AgentSitesCard.tsx` | 站点卡片组件 |
| `web/components/chat/MessageBubble.tsx` | 挂 MessageEmitterContext.Provider |
| `web/components/ai-elements/message.tsx` | 合并注册表到 streamdown |
| `web/src/pages/agent-panel/ArtifactsPanel.tsx` | ExternalSiteView + 事件监听 |
| `web/src/main.tsx` | 导入 builtins |
