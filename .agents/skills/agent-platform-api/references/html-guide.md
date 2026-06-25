# Agent Sites 前端编写指南

构建内嵌于 agent-sites 平台的前端页面。单文件 HTML，PocketBase 后端，iframe 运行环境。重点：设计感 + 可用性 + 自包含。

## 技术约束

- **单文件部署**：所有 CSS/JS 写入一个 HTML 文件（或少量文件经 tar.gz 打包上传）
- **不可用 npm/webpack**：不引入构建工具，CDN 引用除外（如 Tailwind、Chart.js 等 unpkg 资源）
- **API 路径**：前端 `fetch('/api/...')` 会被平台 shim 自动重写为 `fetch('/{app_id}/api/...')`，直接用相对路径 `/api/`
- **iframe 环境**：页面运行在 site 面板的 `<iframe>` 中，宽度约 400-1200px 可调，不要假定全屏
- **不含凭证**：不把 token/key 写进前端代码。数据权限走 collection rules
- **系统字体**：禁止 `@import` 外部字体。用 `system-ui, -apple-system, sans-serif` 等系统字体栈

## 设计先行

动笔写 HTML 之前先构思（不超过 3 句话）：

1. **这个页面给谁看**？
2. **看一眼后，用户记住什么**？（一个数字、一张图、一个按钮？）
3. **调性**：仪表盘、报表、工具、展示页……选一个，全文贯彻

## 页面结构

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App Name</title>
  <style>
    /* 全部 CSS 写在这里 */
    :root { /* 变量先行 */ }
    /* 基础重置 */
    /* 布局 */
    /* 组件 */
    /* 动画 */
  </style>
</head>
<body>
  <!-- 全部 HTML 写在这里 -->
  <div id="app"></div>

  <script>
  // 全部 JS 写在这里
  // 立即执行，不 export/import
  </script>
</body>
</html>
```

## 视觉设计

### 色彩

CSS 变量集中管理。选一个主色 + 一个强调色 + 中性灰阶。不要五彩斑斓。

```css
:root {
  --bg: #0f1117;           /* 深底 */
  --surface: #1a1d27;      /* 卡片底 */
  --border: #2a2d37;       /* 边框 */
  --text: #e1e4ea;         /* 主文字 */
  --text-muted: #8b8fa3;   /* 弱文字 */
  --accent: #4dabf7;       /* 强调色（按钮、高亮） */
  --positive: #51cf66;     /* 涨/成功 */
  --negative: #ff6b6b;     /* 跌/错误 */
}
```

### 布局

- **流动优先**：用 `flex` / `grid`，不要写死像素宽度
- **留白即是设计**：卡片间距 ≥ 16px，内边距 ≥ 12px
- **层次分明**：标题 > 正文 > 辅助文字，字号和颜色严格区分
- **响应式**：单列 → 双列 → 多列，`@media (min-width: 768px)` 起断

```css
.grid { display: grid; gap: 16px; grid-template-columns: 1fr; }
@media (min-width: 768px) { .grid { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .grid { grid-template-columns: repeat(3, 1fr); } }
```

### 微交互

- **hover**：卡片/按钮 hover 时轻微变色或上浮 2px（`transition: 0.15s`，不要超 0.3s）
- **loading**：骨架屏优先于 spinner。数据加载中用 `opacity: 0.5` + `pointer-events: none` 灰掉内容，加载完成后淡入
- **empty**：无数据时显示一行提示文字 + 图标，不白屏

```css
.card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
.card { transition: transform 0.15s, box-shadow 0.15s; }
```

## 数据模式

### 获取列表

```js
async function loadRecords() {
  const res = await fetch('/api/collections/stocks/records?sort=-change&perPage=20');
  const data = await res.json();
  render(data.items);
}
```

### 渲染

用模板字面量构建 HTML 字符串，一次性 `innerHTML`：

```js
function render(items) {
  const html = items.map(item => `
    <div class="card">
      <span class="symbol">${escapeHtml(item.symbol)}</span>
      <span class="price ${item.change > 0 ? 'up' : 'down'}">${item.price}</span>
    </div>
  `).join('');
  document.getElementById('app').innerHTML = html;
}
```

### 防 XSS

任何用户可编辑的字段插入 HTML 前必须转义：

```js
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
```

### 搜索/过滤

客户端实时筛选，用 `input` 事件，200ms debounce：

```js
let timer;
searchInput.addEventListener('input', (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => filter(e.target.value), 200);
});
```

## 常用模式

### 数据看板（Dashboard）

顶行统计卡片 + 下面列表/表格：

```html
<div class="stats">
  <div class="stat-card"><span class="label">总市值</span><span class="value">$2.3T</span></div>
  <div class="stat-card"><span class="label">涨跌家数</span><span class="value up">28 ↑</span></div>
</div>
<div class="list" id="list"></div>
```

### 列表 → 详情（List → Detail）

单列列表，点击弹出底部抽屉/侧边栏：

```css
.drawer { position: fixed; bottom: 0; left: 0; right: 0; max-height: 60vh;
          background: var(--surface); border-radius: 16px 16px 0 0;
          transform: translateY(100%); transition: transform 0.25s; }
.drawer.open { transform: translateY(0); }
```

### 数字格式化

```js
function formatNum(n) { return n != null ? Number(n).toLocaleString() : '-'; }
function formatPct(n) { return n != null ? (n > 0 ? '+' : '') + Number(n).toFixed(2) + '%' : '-'; }
function formatCurrency(n) { return n != null ? '$' + Number(n).toLocaleString() : '-'; }
```

## 禁止

- **禁止**：Arial / Inter / Roboto 作为主要字体（系统默认字体栈除外）
- **禁止**：紫色渐变 + 白色背景（最 cliche 的 AI 美学）
- **禁止**：把原始 JSON 直接 dump 到页面（用户看不懂）
- **禁止**：Loading 状态白屏无提示
- **禁止**：写死像素宽度（`width: 800px`）
- **禁止**：`<a href="http://...">` 外链（iframe 内不可靠，用户需要的链接用文字说明让用户在外部浏览器打开）
- **禁止**：后端交互日志（`console.log` 打印 API 响应可以，但 Error 必须 `console.error`）
- **禁止**：复制粘贴别人的样式就完事——每次建站都要根据站点用途重新构思设计方向
