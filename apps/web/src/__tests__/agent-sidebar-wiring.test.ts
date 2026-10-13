/**
 * 宿主侧栏的装配守卫（源码字符串断言）。
 *
 * 2026-09-28 侧栏智能体树迁走后本文件只留**宿主自己的接线**：树的模型与布局守卫随视图进了
 * `@fenix/ui-components`（`web/__tests__/agent-tree.test.ts`），取数与领域操作进了
 * `@fenix/agent-config/web`；留在宿主的这几条都是「壳怎么把树装进侧栏」的问题。
 *
 * 同批（宿主壳样式收口）第二轮：几何不再按绝对像素写回 CSS——`--spacing` / `--radius-*` / `--text-*`
 * 已在 `@theme` 按 px 落地，工具类写的就是设计值。`shell/AgentSidebar.css` 与 `shell/ShellNavigation.css`
 * 两份伴随表随之退役，残余规则（伪元素、`.agent-sidebar > *` 跨元素覆写、状态优先级、无档取值）收进
 * `apps/web/src/index.css` 的「宿主壳残余样式」段。断言随之改看新落点——守卫意图（单一滚动容器、
 * 垂直可拖拽上边框、折叠态由 React 状态驱动）不变。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 读源码并剥掉注释：组件与残余段的注释会**引用**被禁的旧写法（例如「折叠态原先是一条
 * `.agent-sidebar.collapsed …` 覆写」），逐字符串扫描必须先把注释去掉，否则守卫会被自己的说明文字绊倒。
 * 同一手法见 `packages/ui-components/web/__tests__/agent-tree.test.ts`。
 */
function readSource(path: string): string {
  return readFileSync(resolve(import.meta.dir, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("聊天路由向侧边栏传递当前 Instance", () => {
  const source = readSource("../shell/DefaultAppShell.tsx");

  expect(source).toContain("selectedInstanceId={isChatRoute ? chatSessionId : lastChatSessionRef.current}");
});

// 配置导航分区只允许内容容器滚动，避免与外层包装形成嵌套双滚动条。
// 滚动声明（`h-full` / `overflow-y-auto` / `overflow-x-hidden`）在 `ShellNavigation.tsx` 的 `className`；
// 只有滚动条覆写（`scrollbar-width` / `scrollbar-color` 与 `::-webkit-scrollbar*` 三处伪元素）工具类
// 表达不了，留在 `index.css` 的「宿主壳残余样式」段。
// 包装层的 `h-full min-h-0 overflow-hidden` 仍在 `AgentSidebar.tsx` 的 `className`——
// 「包装层不得成为滚动容器」这一意图不变。
test("配置导航分区保持单一滚动容器", () => {
  const css = readSource("../index.css");
  const navView = readSource("../shell/ShellNavigation.tsx");
  const sidebarView = readSource("../shell/AgentSidebar.tsx");
  const navClass = navView.match(/className="agent-sidebar-nav ([^"]*)"/)?.[1];
  const wrapperClass = sidebarView.match(/className="agent-sidebar-nav-wrap ([^"]*)"/)?.[1];
  const scrollbarOverrides = css.match(/\.agent-sidebar-nav \{([^}]*)\}/)?.[1];

  expect(navClass).toContain("h-full");
  expect(navClass).toContain("overflow-y-auto");
  expect(scrollbarOverrides).toContain("scrollbar-width: thin");
  expect(scrollbarOverrides).toContain("scrollbar-color:");
  expect(css).toContain(".agent-sidebar-nav::-webkit-scrollbar");
  expect(wrapperClass).toContain("overflow-hidden");
  expect(wrapperClass).not.toContain("overflow-y-auto");
  expect(wrapperClass).not.toContain("overflow-auto");
});

// 智能体区域上边框必须装配为垂直可拖动分隔线。
// 手柄与树面板的 className 是本条的两个锚点：`handleIndex < treeIndex` 保证分隔线夹在导航面板与树面板
// **之间**（顺序反了会变成树在上、分隔线在下，拖动语义随之反转）；手柄的 1px 高度（`h-px`）与悬停 /
// 拖动中的强调青已撤回 `className`，只剩过渡（`ease` 初值曲线）与 `::after` 命中区留在残余段。
test("智能体区域使用可拖动上边框调整高度", () => {
  const source = readSource("../shell/AgentSidebar.tsx");
  const handleIndex = source.indexOf(
    '"agent-sidebar-tree-resize-handle h-px z-2 shrink-0 cursor-row-resize bg-white/14 hover:bg-(--agent-sidebar-cyan)"',
  );
  const treeIndex = source.indexOf('"agent-sidebar-tree-wrap flex flex-col h-full overflow-hidden"');

  expect(source).toContain(
    '<ResizablePanelGroup orientation="vertical" className="agent-sidebar-sections flex-auto min-h-0">',
  );
  expect(source.match(/<ResizablePanel /g)).toHaveLength(2);
  expect(source).toContain('defaultSize="44%" minSize="120px"');
  expect(source).toContain('defaultSize="56%" minSize="160px"');
  expect(handleIndex).toBeGreaterThan(0);
  expect(treeIndex).toBeGreaterThan(handleIndex);
  expect(source).toContain('aria-label={tSidebar("resizeAgentArea")}');
});

// 折叠态只允许由 React 状态驱动：宽度用两个**互斥的刻度类串**，按状态不同的几何一律写进同一个条件表达式
// 的两支（`collapsed ? … : …`），不再用 `.agent-sidebar.collapsed …` 这类后代选择器，也不用 `--collapsed`
// 修饰类做同属性覆写（那正是收口拆掉的写法，回流即与工具类争胜负）。唯一留下的修饰类是**钩子**：
// 条目修饰类挂着指示条伪元素的偏移（伪元素够不着 `className`），原先的品牌区 / 树面板 / 底部容器 /
// 用户面板 / 用户行 / 字标六处修饰类已随几何一起撤回条件类串。
// 残余段里的指示条两条规则同特指度、靠**源顺序**取胜，顺序反了会静默退回 8px，故在此钉住。
test("折叠态由 React 状态给条件类名而非后代选择器", () => {
  const view = readSource("../shell/AgentSidebar.tsx");
  const navView = readSource("../shell/ShellNavigation.tsx");
  const css = readSource("../index.css");

  expect(view).toContain('collapsed ? "w-16 min-w-16" : "w-60 min-w-60"');
  expect(view).toContain('"grow shrink basis-auto min-h-0 invisible pointer-events-none"');
  expect(view).toContain('collapsed ? "justify-center px-0 py-3.5" : "px-4.5 py-3.5"');
  expect(view).toContain('collapsed ? "pt-2 px-2.5 pb-3" : ""');
  expect(view).toContain('collapsed ? "justify-center min-h-12 border-b-0" : "border-b border-white/8"');
  expect(view).toContain('collapsed ? "justify-center gap-0" : "gap-2.5"');
  expect(navView).toContain('"agent-sidebar-nav-item--collapsed w-12 min-w-0 justify-center mx-2 px-0 py-2.5"');
  expect(css).not.toContain(".agent-sidebar.collapsed");
  const indicatorBase = css.indexOf(".agent-sidebar-nav-item.active::before");
  const indicatorCollapsed = css.indexOf(".agent-sidebar-nav-item--collapsed.active::before");
  expect(indicatorBase).toBeGreaterThan(0);
  expect(indicatorCollapsed).toBeGreaterThan(indicatorBase);
});

// 侧栏壳的几何由刻度类表达（2026-09-28 复议）：`--spacing` / `--radius-*` / `--text-*` 已在两份 `@theme`
// 按 px 落地，工具类写的就是设计值（`w-60` = 240px、`min-h-18` = 72px、`size-11` = 44px、`text-xs` =
// 12px）。上一版「13px 根字号 → 刻度只渲染名义值 0.8125 倍 → 原值必须手写 CSS」的口径已作废，断言方向
// 因此反过来：**维度取值必须在 `className`**，只有工具类表达不了的那几类才允许留在残余段。
test("侧栏壳几何由刻度类表达，CSS 只留表达不了的", () => {
  const view = readSource("../shell/AgentSidebar.tsx");
  const navView = readSource("../shell/ShellNavigation.tsx");
  const css = readSource("../index.css");

  // 宽度 240 / 64px、品牌区 14 / 18px 内边距与 72px 高度下限、折叠按钮 24×24 与图标 14×14
  expect(view).toContain('"w-60 min-w-60"');
  expect(view).toContain('"agent-sidebar-brand flex items-center min-h-18 border-b border-white/10 no-underline"');
  expect(view).toContain("top-6 -right-3 size-6");
  expect(view).toContain('className="size-3.5 stroke-2"');
  // 拖拽手柄 1px、用户行 40px / 12px、用户名与组织名左间距 10px
  expect(view).toContain("agent-sidebar-tree-resize-handle h-px z-2 shrink-0 cursor-row-resize");
  expect(view).toContain("agent-sidebar-user-button flex min-h-10 px-3 w-full items-center");
  expect(view).toContain("agent-sidebar-user-name truncate flex-1 min-w-0 pl-2.5 text-left text-13");
  expect(view).toContain("agent-sidebar-org-row flex min-h-10 px-3 w-full items-center");
  expect(view).toContain("agent-sidebar-org-name truncate flex-1 min-w-0 pl-2.5 text-left text-11 font-normal");
  // 头像槽 32×26、头像 26px 圆、组织图标 16px、两处 chevron 14px、品牌标记 44px 与字标间距 / 下边距
  expect(view).toContain("agent-sidebar-avatar-slot w-8 h-6.5 flex shrink-0 items-center justify-center");
  expect(view).toContain("agent-sidebar-avatar size-6.5 flex shrink-0 items-center justify-center rounded-full");
  expect(view).toContain("agent-sidebar-org-icon-wrap w-8 h-6.5 flex shrink-0 items-center justify-center");
  expect(view).toContain('"agent-sidebar-org-icon size-4 shrink-0 text-white/45"');
  expect(view).toContain('"agent-sidebar-user-chevron size-3.5 shrink-0 text-white/30"');
  expect(view).toContain('"fenix-sidebar-logo-mark size-11 block shrink-0 object-contain object-center"');
  expect(view).toContain("fenix-sidebar-logo-text min-w-0 flex flex-col gap-px text-white/96 leading-none");
  expect(view).toContain('"fenix-sidebar-logo-main mb-0.75 font-extrabold whitespace-nowrap text-17 tracking-6"');
  // 快捷导航：条目几何（间距 / 纵向外边距 / 宽度 / 内边距 / 字号）、分组标签内边距、条目图标 18px。
  // 展开态的底串**不得有横向外边距**，宽度与横向留白交给展开支的 `w-full px-6`——这正是「高亮铺满侧栏
  // 整宽」的落点（2026-09-29 复议）：`mx-*` 回到底串会左右各内缩 8px，`w-full` 被删则 `<button>` 退回
  // fit-content（实测 112px / 侧栏 240px），两种写法都会让高亮缩成一小块。
  // 折叠支的 `w-12` + `mx-2` 由上面「折叠态」那条钉住（8 + 48 + 8 = 64px）。
  const navItemBase = navView.match(/"(agent-sidebar-nav-item [^"]*)"/)?.[1] ?? "";
  expect(navItemBase).toContain("gap-2.5 my-px");
  expect(navItemBase).not.toContain("mx-");
  expect(navView).toContain('"w-full px-6 py-1.5"');
  expect(navView).toContain("agent-sidebar-section-label block pt-2.5 px-4 pb-1 text-3xs");
  expect(navView).toContain('<Icon className="size-4.5 flex-shrink-0" strokeWidth={1.7} />');
  // 退回 CSS 的只允许「工具类表达不了」那几类：几何声明与已经作废的宽度变量都不得回流。
  expect(css).not.toContain("--agent-sidebar-width");
  expect(css).not.toContain("--agent-sidebar-collapsed");
  expect(css).not.toContain("padding: 14px 18px");
  expect(css).not.toContain("min-height: 72px");
  expect(css).not.toContain("height: 1px");
  expect(css).not.toContain("min-height: 40px");
  expect(css).not.toContain("padding: 0 12px");
  expect(css).not.toContain("padding-left: 10px");
  expect(css).not.toContain("gap: 10px");
  expect(css).not.toContain("margin: 1px 8px");
  expect(css).not.toContain("padding: 6px 16px");
  expect(css).not.toContain("width: 48px");
  expect(css).not.toContain("width: 18px");
  expect(css).not.toContain("padding: 10px 16px 4px");
  // 2026-09-28 第三批（表内不留 px 字面量）：11px / 17px 字号与 10px 圆角已随 `--text-11` / `--text-17` /
  // `--radius-10` 补齐撤回 `className`（`text-11` / `text-17` / `rounded-10`），三条都不得回流残余段。
  expect(view).toContain("text-white/55 text-11");
  expect(view).toContain("agent-sidebar-footer-card rounded-10");
  // 副字标 10.5px 归一到 10px 档（`text-3xs`，主控裁定；点号不是合法 token 名，不新建 `--text-10.5`）。
  expect(view).toContain("opacity-72 text-3xs tracking-4");
  expect(css).not.toContain("font-size: 11px");
  expect(css).not.toContain("font-size: 17px");
  expect(css).not.toContain("font-size: 10.5px");
  expect(css).not.toContain("border-radius: 10px");
  // 2026-09-28 第四批（表内不留字面量）：字距 / 行高 / 描边宽与选中态三条同样只许在 `className`。
  expect(view).toContain("strokeWidth={2.2}");
  expect(navView).toContain("leading-[1.4]");
  expect(navView).toContain("leading-[1.2]");
  expect(navView).toContain("inset-ring-1 inset-ring-white/8");
  expect(css).not.toContain("letter-spacing: 0.06em");
  expect(css).not.toContain("letter-spacing: 0.04em");
  expect(css).not.toContain("line-height: 1.4");
  expect(css).not.toContain("line-height: 1.2");
  expect(css).not.toContain("stroke-width: 2.2");
  expect(css).not.toContain("stroke-width: 1.7");
  expect(css).not.toContain(".agent-sidebar-nav-item.active {");
});
