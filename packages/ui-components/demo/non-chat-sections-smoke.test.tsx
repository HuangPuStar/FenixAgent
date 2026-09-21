import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setupDemoI18n } from "./i18n";
import { Providers } from "./providers";
import { AgentL1Section } from "./sections/agent-l1";
import { BaseUiP1Section } from "./sections/base-ui-p1";
import { BaseUiP2Section } from "./sections/base-ui-p2";
import { BaseUiP3Section } from "./sections/base-ui-p3";
import { DataL1Section } from "./sections/data-l1";
import { DataL2Section } from "./sections/data-l2";
import { DesignTokensSection } from "./sections/design-tokens";
import { FileL1Section } from "./sections/file-l1";
import { FileL2Section } from "./sections/file-l2";
import { PreviewL1Section } from "./sections/preview-l1";
import { PreviewL2Section } from "./sections/preview-l2";
import { WorkbenchL1Section } from "./sections/workbench-l1";
import { WorkbenchL2Section } from "./sections/workbench-l2";

/**
 * demo 非 chat 分区的冒烟测试：Design Tokens、Base UI P1/P2/P3 与各业务域 L 系列（File / Preview /
 * Workbench / Data / Agent）在无宿主环境下渲染，并断言每个分区都产出了它这一层应承载的示例标题。
 *
 * 与 `chat-smoke.test.tsx`（Chat L1–L4 的交互链路）和 `app-shell.test.tsx`（侧栏装配）分工：
 * 这边只保证各层的示例在分区重组 / 示例搬迁后仍然齐全可渲染 —— 按层级重组时最容易发生的事故是
 * 示例漏搬、或 import 指向已删除的旧分区模块，前者在这里暴露，后者在 typecheck 阶段暴露。
 *
 * 依赖 happy-dom（根 package.json 已声明）。node 侧没有 DOM 构造器，组件在渲染期做
 * `instanceof` 判断或构造尺寸对象时会直接抛 ReferenceError，因此需要在文件顶部把
 * window/document 以及本次渲染路径真正用到的构造器注入 globalThis。
 */

const window = initializeHappyDomWindow(new Window());
// biome-ignore lint/suspicious/noExplicitAny: 测试环境需要把 happy-dom 的 DOM 注入全局
(globalThis as any).window = window;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).document = window.document;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).navigator = window.navigator;
// biome-ignore lint/suspicious/noExplicitAny: 同上（与 happy-dom 的 Blob/File 同源）
(globalThis as any).FileReader = window.FileReader;
// biome-ignore lint/suspicious/noExplicitAny: 同上（组件读取元素尺寸）
(globalThis as any).getComputedStyle = window.getComputedStyle.bind(window);
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).ResizeObserver = window.ResizeObserver;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).HTMLElement = window.HTMLElement;
// biome-ignore lint/suspicious/noExplicitAny: 同上（streamdown 的 diff 组件按 `customElements.get` 判定自定义元素）
(globalThis as any).customElements = window.customElements;
// biome-ignore lint/suspicious/noExplicitAny: 同上（Resizable 依赖 Node 判断面板元素）
(globalThis as any).Node = window.Node;
// biome-ignore lint/suspicious/noExplicitAny: 同上（Switch 等表单控件做表单关联判断）
(globalThis as any).HTMLFormElement = window.HTMLFormElement;
// biome-ignore lint/suspicious/noExplicitAny: 同上（Resizable 读取面板尺寸时构造 DOMRect）
(globalThis as any).DOMRect = window.DOMRect;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).Element = window.Element;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).Event = window.Event;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).MouseEvent = window.MouseEvent;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).CustomEvent = window.CustomEvent;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).SVGElement = window.SVGElement;
// biome-ignore lint/suspicious/noExplicitAny: 同上（happy-dom 的 requestAnimationFrame 绑定到它的 window）
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
// biome-ignore lint/suspicious/noExplicitAny: React 19 的 act 环境标记
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

setupDemoI18n();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div") as HTMLDivElement;
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("demo non-chat sections", () => {
  // Design Tokens 分区：token 抽样与主题示例都在，且变量名出现在页面上。
  // 需要 Providers —— 该分区的 useTheme 在 ThemeProvider 之外会直接抛错。
  test("renders design tokens", () => {
    act(() =>
      root.render(
        <Providers>
          <DesignTokensSection />
        </Providers>,
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Design Tokens");
    expect(text).toContain("--color-brand");
    expect(text).toContain("ThemeToggle / useTheme");
  });

  // Base UI P1 收窄为页面骨架后只应保留 AppPage / AppHeader；工作台相关的示例属于 Workbench L 系列。
  test("renders Base UI P1 page frame only", () => {
    act(() => root.render(<BaseUiP1Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Base UI P1");
    expect(text).toContain("AppPage / AppHeader");
    expect(text).not.toContain("WorkbenchPanel");
    expect(text).not.toContain("MasterDetailWorkspace");
  });

  // Base UI P2 收窄为通用对话框容器：数据、文件与预览容器已各自迁到业务域 L 系列。
  test("renders Base UI P2 dialog containers only", () => {
    act(() => root.render(<BaseUiP2Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Base UI P2");
    expect(text).toContain("ConfirmDialog");
    expect(text).toContain("FormDialog");
    expect(text).not.toContain("FileTreeView");
    expect(text).not.toContain("DataTable");
  });

  // Base UI P3：基础控件齐全，并已收编从 Chat 下沉的通用展示件（对话气泡、消息附件与代码 / 占位 / iframe）。
  test("renders Base UI P3 controls and the pieces descended from Chat", () => {
    act(() => root.render(<BaseUiP3Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Base UI P3");
    expect(text).toContain("AlertDialog");
    expect(text).toContain("DropdownMenu");
    expect(text).toContain("Table：loading / empty / error");
    expect(text).toContain("Conversation / Message / MessageResponse");
    expect(text).toContain("MessageAttachments");
    expect(text).toContain("CodeBlock");
    expect(text).toContain("Shimmer");
    expect(text).toContain("IframePreview");
  });

  // File L1：树容器与节点交互（含 loading / stale 开关与搜索）随示例一起搬到了独立分区。
  test("renders File L1 tree", () => {
    act(() => root.render(<FileL1Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("File L1");
    expect(text).toContain("FileTreeView");
  });

  // File L2：叠在树上的新建 / 重命名对话框两种形态。
  test("renders File L2 input dialogs", () => {
    act(() => root.render(<FileL2Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("File L2");
    expect(text).toContain("FileTreeInputDialog — New folder");
    expect(text).toContain("FileTreeInputDialog — Rename");
  });

  // Preview L1：预览容器的空态与加载态两个分支并列展示。
  test("renders Preview L1 container states", () => {
    act(() => root.render(<PreviewL1Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Preview L1");
    expect(text).toContain("PreviewTab");
  });

  // Preview L2：预览器本体与它的渲染插件入口（文本与 HTML 两种文件类型）。
  test("renders Preview L2 viewers", () => {
    act(() => root.render(<PreviewL2Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Preview L2");
    expect(text).toContain("FileViewerPreview — text");
    expect(text).toContain("FileViewerPreview — html (html-plugin)");
  });

  // Workbench L1：主从工作台骨架（索引 / 头部 / 详情 / 底部四段）。
  test("renders Workbench L1 master-detail skeleton", () => {
    act(() => root.render(<WorkbenchL1Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Workbench L1");
    expect(text).toContain("MasterDetailWorkspace");
  });

  // Workbench L2：工作台面板表面。
  test("renders Workbench L2 panel surface", () => {
    act(() => root.render(<WorkbenchL2Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Workbench L2");
    expect(text).toContain("WorkbenchPanel");
  });

  // Data L1：数据表格的排序、过滤、展开与分页。
  test("renders Data L1 table", () => {
    act(() => root.render(<DataL1Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Data L1");
    expect(text).toContain("DataTable");
  });

  // Data L2：表格周边的批量操作、状态徽标、文件类型图标与空态。
  test("renders Data L2 surroundings", () => {
    act(() => root.render(<DataL2Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Data L2");
    expect(text).toContain("Table + Checkbox + BatchActionBar");
    expect(text).toContain("StatusBadge");
    expect(text).toContain("FileTypeIcon");
    expect(text).toContain("EmptyState：No components yet");
  });

  // Agent L1：智能体卡片列表（搜索、网格布局与批量选择）。
  test("renders Agent L1 card list", () => {
    act(() => root.render(<AgentL1Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Agent L1");
    expect(text).toContain("AgentCardList");
  });
});
