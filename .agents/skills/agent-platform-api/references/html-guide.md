# Agent Sites 前端编写指南

构建内嵌于 agent-sites 平台的单文件 HTML 应用。PocketBase 后端 + iframe 运行环境。不要写平庸的 CRUD 页面——把每个站点当成独立产品来设计。

## 设计先行

写代码之前，先回答四个问题——这是区分 "能用" 和 "好看" 的关键：

### 1. 用途

这个页面解决什么问题？谁在用？
- 老板看 KPI 看板 → 一目了然，不滚动
- 交易员盯盘 → 实时数据，对比强烈
- 普通用户浏览内容 → 舒适阅读，引导性强

### 2. 调性

选一个方向并贯彻到底。不要中庸。

| 调性 | 特征 | 适合场景 |
|------|------|----------|
| 金融暗色 | 深底、荧光强调色、等宽数字、刀削般卡角 | 股票、交易、数据看板 |
| 极简白 | 大留白、单一线框、灰度层级、无阴影 | 文档、API 工具、搜索页 |
| 粗野工业 | 粗边框、高对比黑白、碰撞布局、原始字体 | 展示页、作品集 |
| 柔和暖色 | 奶油底、圆角、低对比、渐变点缀 | 社区、博客、内容页 |
| 霓虹终端 | 黑底绿字、scanline 效果、等宽字体 | 状态监控、命令行风格 |

选好之后，每行 CSS 都问自己：这符合我的调性吗？

### 3. 记忆点

这个页面最让人记住的是什么？只能有一个。

- 一组巨大的数字？→ 字号拉到 48px，周围大量留白
- 一条动态曲线？→ 放在首屏 C 位，其他都是配角
- 一个独特的交互？→ 让用户忍不住试第二次

### 4. 约束

- iframe 内，宽度 400-1200px，不要假定全屏
- 单文件，所有 CSS 写 `<style>`、所有 JS 写 `<script>`
- 不能 `@import` 外部字体，用系统字体（`system-ui`、`ui-monospace`）
- 从 PocketBase 取数据，`fetch('/api/...')` 相对路径

## 色彩

CSS 变量统一管理。规则：一个主色 + 至多一个强调色 + 中性灰阶。超过三个颜色的页面 = 没有方向。

```css
:root {
  /* 深色金融 —— 暗底 + 荧光强调 */
  --bg: #0a0e14;
  --surface: #141a22;
  --border: #1e2733;
  --text: #c8d6e5;
  --text-muted: #566575;
  --accent: #00d4aa;       /* 荧光绿 */
  --positive: #00d4aa;
  --negative: #ff4757;     /* 鲜明红 */

  /* 极简白 —— 少即是多 */
  --bg: #fafafa;
  --surface: #ffffff;
  --border: #e5e5e5;
  --text: #111111;
  --text-muted: #888888;
  --accent: #000000;
}
```

两个关键原则：
- **底色不白即黑**，不要浅灰（`#f5f5f5` 是懒人选择，`#0a0e14` 或 `#fafafa` 才是态度）
- **强调色饱和拉满**：`#00d4aa` 而不是 `#a0d4aa`。不敢用亮色 = 不敢做选择

## 排版

没有外部字体的情况下，靠字重、字号、字间距创造层次：

```css
/* 数据优先 */
--font-mono: ui-monospace, 'SF Mono', Menlo, monospace;
/* 阅读优先 */
--font-sans: system-ui, -apple-system, sans-serif;

/* 层次阶梯 —— 至少拉开 3-4 级 */
.h1 { font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; }
.h2 { font-size: 1.25rem; font-weight: 600; }
.body { font-size: 0.875rem; line-height: 1.6; }
.caption { font-size: 0.75rem; color: var(--text-muted); letter-spacing: 0.03em; text-transform: uppercase; }
```

数字一定要用等宽字体——`ui-monospace`。`1,234,567` 和 `1，234，567` 观感完全不同。

## 布局

网格不是用来整齐的——是用来打破的。

### 基础网格

```css
.grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}
```

`auto-fill` + `minmax` 比固定断点优雅，在不同宽度下自动适应。

### 打破网格

前两个卡片满网格排，第三个突出：

```css
.grid > *:nth-child(3) {
  grid-column: 1 / -1;
  /* 这个卡片横跨整行，和其他不同 */
}
```

### 不对称

左右不对称比对称更有设计感：

```
┌─────────────┬──────┐
│             │      │
│   主要内容   │ 侧栏 │   ← 不是 50/50
│             │      │
└─────────────┴──────┘
```

### 大数字（数据看板）

最大的数字 = 全页的主视觉：

```css
.kpi-value {
  font-size: 3rem;           /* 大到夸张 */
  font-weight: 800;
  font-family: var(--font-mono);
  letter-spacing: -0.03em;
  line-height: 1;
  /* 大量留白环绕，不用 card 框住 */
}
```

## 动效

CSS-only，高效不卡。重点：首次加载的入场 > 琐碎的 hover 动效。

### 页面入场

加载完成后，内容从下方向上浮入，每个卡片延迟递增：

```css
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
}

.card {
  opacity: 0;
  animation: fadeUp 0.4s ease-out forwards;
}
.card:nth-child(1) { animation-delay: 0.05s; }
.card:nth-child(2) { animation-delay: 0.10s; }
.card:nth-child(3) { animation-delay: 0.15s; }
```

注意：JS 渲染数据后，CSS animation 会自动触发。不需要用 JS 添加 class。

### 数字跳动

数据更新时，用 transition 平滑过渡：

```css
.price { transition: color 0.3s; }
.price.up   { color: var(--positive); }
.price.down { color: var(--negative); }
```

### 滚动效果

页面滚动时，内容逐渐显现（纯 CSS）：

```css
@keyframes appear {
  from { opacity: 0; transform: translateY(24px); }
}
@supports (animation-timeline: scroll()) {
  .card { animation: appear linear both; animation-timeline: scroll(); animation-range: entry 10% entry 90%; }
}
```

## 背景

不要只铺一个纯色底色，至少加一层细节：

```css
body {
  background-color: var(--bg);
  /* 叠加噪声纹理 */
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
}
```

或者一个微妙的径向渐变（不要明显的线性渐变）：

```css
body {
  background: radial-gradient(ellipse 80% 50% at 50% -20%, rgba(0,212,170,0.08), transparent),
              var(--bg);
}
```

## 页面结构

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App Name</title>
  <style>
    /* ── 变量 ── */
    :root { }
    /* ── 重置 ── */
    *,*::before,*::after{box-sizing:border-box;margin:0}
    body{font-family:var(--font-sans);background:var(--bg);color:var(--text);padding:24px}
    /* ── 布局 ── */
    /* ── 组件 ── */
    /* ── 动效 ── */
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
  // ── 数据 ──
  // ── 渲染 ──
  // ── 交互 ──
  </script>
</body>
</html>
```

## 数据模式

### 获取

```js
const API = '/api/collections';

async function load(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 列表
const { items } = await load('/stocks/records?sort=-marketCap&perPage=50');

// 单条
const record = await load('/stocks/records/apple-inc');
```

### 渲染

用模板字面量构建 HTML，一次性 `innerHTML`（不要逐条 `appendChild`）：

```js
function render(items) {
  if (!items.length) {
    app.innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }
  app.innerHTML = items.map((item, i) => `
    <div class="card" style="animation-delay:${i * 0.04}s">
      <span class="symbol">${esc(item.symbol)}</span>
      <span class="price ${item.change > 0 ? 'up' : 'down'}">${fmt.price(item.price)}</span>
    </div>
  `).join('');
}
```

### 防 XSS

所有用户可控内容插入前转义：

```js
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
```

### 搜索/过滤

客户端筛选 + debounce：

```js
app.querySelector('.search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = e.target.value.toLowerCase();
    render(allItems.filter(it => it.symbol.toLowerCase().includes(q)));
  }, 150);
});
```

## 常用 UI 模式

### Dashboard 统计卡

```html
<header class="kpi-row">
  <div class="kpi">
    <div class="kpi-label">Total Market Cap</div>
    <div class="kpi-value">$2.34T</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Advancers/Decliners</div>
    <div class="kpi-value">
      <span class="up">28</span> / <span class="down">12</span>
    </div>
  </div>
</header>
```

```css
.kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 24px; margin-bottom: 32px; }
.kpi-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin-bottom: 8px; }
.kpi-value { font-family: var(--font-mono); font-size: 2.5rem; font-weight: 800; letter-spacing: -0.03em; }
```

### 底部抽屉（详情）

```css
.drawer {
  position: fixed; bottom: 0; left: 0; right: 0;
  max-height: 70vh; overflow-y: auto;
  background: var(--surface);
  border-radius: 16px 16px 0 0;
  transform: translateY(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 -8px 32px rgba(0,0,0,0.3);
}
.drawer.open { transform: translateY(0); }
.drawer-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  opacity: 0; pointer-events: none; transition: opacity 0.3s;
}
.drawer.open + .drawer-backdrop,
.drawer-backdrop.active { opacity: 1; pointer-events: auto; }
```

### 数据表格

```css
.table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.table th { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em;
             color: var(--text-muted); text-align: right; padding: 8px 12px;
             border-bottom: 2px solid var(--border); }
.table th:first-child { text-align: left; }
.table td { padding: 10px 12px; border-bottom: 1px solid var(--border);
             font-family: var(--font-mono); text-align: right; }
.table td:first-child { font-family: var(--font-sans); text-align: left; font-weight: 500; }
.table tr:hover td { background: rgba(255,255,255,0.03); }
```

### 数字格式化工具

```js
const fmt = {
  num:  n => n != null ? Number(n).toLocaleString() : '-',
  pct:  n => n != null ? (n > 0 ? '+' : '') + Number(n).toFixed(2) + '%' : '-',
  usd:  n => n != null ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-',
  cap:  n => { if (!n) return '-'; const t = n >= 1e12 ? 'T' : n >= 1e9 ? 'B' : n >= 1e6 ? 'M' : ''; return t ? '$' + (n / (t === 'T' ? 1e12 : t === 'B' ? 1e9 : 1e6)).toFixed(1) + t : '$' + Number(n).toLocaleString(); },
};
```

## 禁止

- **AI 三大俗**：紫色渐变白底 / 全圆角大阴影卡片 / 每个元素都居中
- **字体**：不要 Arial、Inter、Roboto。系统字体栈已经是中性选择，不需要指定
- **留白吝啬**：`padding: 8px`、`gap: 8px` 是懒人值。试试 `16px`、`24px`、`32px`
- **配色平庸**：`#333` 配 `#f5f5f5` 是没做选择。要么纯黑 `#000`，要么深暗 `#0a0e14`，要么纯白 `#fff`
- **Loading 白屏**：数据异步加载时，页面先渲染骨架结构，再填充数据。不要让用户看白屏
- **JSON dump**：不要把 API 返回的原始 JSON 打印到页面上。格式化、分类、加单位
- **写死宽度**：不要 `width: 800px`，用 `max-width` + 百分比
- **外链 `<a>`**：iframe 内不可靠。改用文字说明让用户复制到浏览器
- **复制粘贴**：每建一个站都要重新设计。上一个站的暗色金融主题，不要再套用到下一个站
- **同一个调性连用两次**：如果上一个站是深色金融，下一个必须换——试试极简白、粗野工业、霓虹终端
