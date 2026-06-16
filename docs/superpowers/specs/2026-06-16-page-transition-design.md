# 页面跳转统一过渡动画 — 设计文档

**日期**：2026-06-16
**主题**：为前端所有路由跳转添加统一的淡入淡出过渡，消除 sidebar 菜单切换与 chat ↔ 其他页面切换时的闪烁僵硬感。

## 背景

当前前端（React 19 + Vite + TanStack Router v1.170）没有任何页面过渡动画。TanStack Router 未配置 `defaultPendingComponent`，路由切换时存在两个明显的视觉问题：

1. **Sidebar 菜单切换**：loader 等待期间主内容区瞬间空白，然后新页面才渲染。
2. **Chat ↔ 其他页面跨布局切换**：`AgentAppShell`（chat 专用，两栏布局）与 `AgentPanelLayout`（sidebar + Outlet）整体替换，造成"布局重排"的闪烁。

**目标场景**：sidebar 菜单切换、chat ↔ 其他页面切换（用户主诉）。
**非目标**：登录页内部交互动画、组件级装饰动画。

## 方案

### 选型对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| **A. TanStack Router 内置 `<ViewTransition>`**（选中） | 浏览器原生"冻结旧帧"覆盖 loader 空白；零新依赖；代码极简 | Firefox / Safari < 18 降级为瞬时切换 |
| B. `motion` + `AnimatePresence` | 跨浏览器一致 | AnimatePresence 是先卸载旧再挂载新，**无法**冻结旧帧；增加打包 |
| C. 组合方案（VT + motion 兜底） | 两全 | 两套代码路径，维护成本翻倍 |

**选 A** 的理由：与"冻结旧帧"诉求完美匹配；TanStack Router 原生支持；内部控制台以 Chrome 为主，降级场景可接受。

### 核心机制

利用浏览器 [View Transitions API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API)（`document.startViewTransition`），由 TanStack Router v1.170 内置的 `<ViewTransition>` 组件自动调用。浏览器在路由变化时：

1. **立即**对当前 DOM 拍快照（旧帧）
2. 在 callback 内加载新路由（lazy import + loader）
3. 新 DOM 挂载后，对旧/新帧做 cross-fade

步骤 1-2 期间浏览器持续显示旧帧——这就是"冻结旧帧"消除闪烁的本质。

## 文件改动清单

**新增文件**：无。
**新增依赖**：无（TanStack Router v1.170 已内置 VT 支持）。

### 1. `web/src/main.tsx`

在 `createRouter` 中开启全局 VT：

```ts
const router = createRouter({
  routeTree,
  basepath: "/ctrl",
  defaultViewTransition: true, // 新增：开启 VT
});
```

### 2. `web/src/routes/__root.tsx`

3 个 `<Outlet />` 分支中，未登录与已登录两个分支用 `<ViewTransition>` 包裹。`isPending` 分支是 loading 状态，不需要过渡。

```tsx
import { ViewTransition } from "@tanstack/react-router";

// 已登录分支
<OrgProvider>
  <ViewTransition>
    <Outlet />
  </ViewTransition>
  <Toaster richColors closeButton position="top-right" />
</OrgProvider>

// 未登录分支
<ThemeProvider defaultTheme="system">
  <ViewTransition>
    <Outlet />
  </ViewTransition>
</ThemeProvider>
```

**关键约束**：`<Toaster>` 放在 `<ViewTransition>` **外层**——否则 toast 弹出会被 VT 截图干扰。

### 3. `web/src/index.css`

文件末尾追加淡入淡出动画：

```css
/* 页面跳转过渡：root cross-fade（200ms） */
::view-transition-old(root) {
  animation: vt-fade-out 200ms ease-out both;
}
::view-transition-new(root) {
  animation: vt-fade-in 200ms ease-out both;
}

@keyframes vt-fade-out {
  to { opacity: 0; }
}
@keyframes vt-fade-in {
  from { opacity: 0; }
}
```

项目已有 `@media (prefers-reduced-motion: reduce)`（`index.css` 第 483-491 行）全局规则，会把 200ms 缩到 0.01ms，VT 自动失活，无需额外无障碍处理。

### 不需要改动的文件

- `_panel.tsx` 的 `AgentPanelLayout` 内部 `<Outlet />` — 过渡在 root 层统一处理
- `AgentAppShell.tsx`、`AgentPanelLayout.tsx` — 布局组件本身不变
- `package.json` — 无新依赖

## 数据流（单次路由切换）

```
用户点击 <Link> / 调用 navigate()
        ↓
TanStack Router 触发 navigation 事件
        ↓
<ViewTransition> 捕获，检测 document.startViewTransition
        ↓
   ┌──── 支持 ────┐              ┌──── 不支持 ────┐
   ↓              ↓              ↓                 ↓
拍旧帧快照       callback 内      直接 commit       瞬时切换
                commit location
                加载 lazy / loader
                挂载新 DOM
                ↓
                cross-fade 200ms
```

## 边界与特殊情况

| 场景 | 行为 |
|------|------|
| Firefox / Safari < 18（不支持 VT API） | TanStack Router 内部 try-catch 后直接 commit location，瞬时切换，无报错 |
| `prefers-reduced-motion: reduce` | 项目已有全局规则把动画缩到 0.01ms，VT 自动失活 |
| loader 长时间不返回 | 旧帧持续显示直到 resolve（VT 优势） |
| 同一 pathname 的 search params 变化 | 默认仍触发 VT，旧/新 DOM 几乎一致，cross-fade 不可察觉，无副作用 |
| 登录 ↔ 主面板切换 | `__root.tsx` `useEffect` 触发的 navigate 也会被 VT 覆盖 |
| Toaster（sonner toast） | 放在 `<ViewTransition>` 外层，新 toast 在过渡中能正常弹出 |
| WebSocket / ACP relay 事件 | 不受影响 — VT 只截取 DOM 视觉状态，不阻塞 JS 事件循环 |

## 动画参数

- **时长**：200ms
- **缓动**：`ease-out`
- **类型**：仅 `root`（不命名其他 view-transition type，保持简单）
- **方向**：旧帧 fade-out、新帧 fade-in 同时进行（VT 默认）

## 测试与验证

### 不新增单元测试

项目 CLAUDE.md 明确："前端只测关键流程（表单提交、数据操作、导航路由、状态联动），不写类型检查测试和纯 UI 结构断言"。页面过渡是纯视觉效果，没有业务逻辑断言空间，强行加测试只会变成脆弱的样式断言。

### 手动验证清单

1. **Sidebar 菜单切换**：Models → Skills → MCP → Dashboard → Knowledge Bases → Tasks，每次切换 ~200ms 平滑淡入淡出，无瞬间空白
2. **Chat ↔ 跨布局切换**：Dashboard → 进入 chat（`/agent/chat/$agentId`）→ 返回 Dashboard。整体 cross-fade，不应看到布局重排闪烁
3. **登录 ↔ 主面板**：退出登录 → 登录页淡入；登录成功 → 主面板淡入
4. **reduced-motion 验证**：macOS 系统偏好启用「减少动态效果」，切换路由应接近瞬时
5. **Firefox 降级**（可选）：切换应瞬时完成，控制台无 `startViewTransition is not a function` 之类报错

### 构建验证

```bash
bun run build:web    # 必须通过
bun run precheck     # 提交前必须通过
```

## 回滚策略

如果上线后出现问题（晕眩、性能、兼容性），回滚成本极低：
- 删除 `<ViewTransition>` 包裹（2 处：未登录与已登录分支）
- 删除 `defaultViewTransition: true`
- 删除 CSS 中 2 条 `::view-transition-*` 规则 + 2 条 `@keyframes`

总共约 15 行变更，5 分钟内可回滚。

## 参考资料

- [ViewTransitionOptions type | TanStack Router Docs](https://tanstack.com/router/v1/docs/api/router/ViewTransitionOptionsType)
- [MDN: View Transitions API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API)
- [Super-Smooth Page Animations in TanStack Router Using View Transitions](https://javascript.plainenglish.io/super-smooth-page-animations-in-tanstack-router-using-view-transitions-01bebeb75e86)
