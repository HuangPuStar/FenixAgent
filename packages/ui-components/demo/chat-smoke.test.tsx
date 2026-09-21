import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setupDemoI18n } from "./i18n";
import { ChatL1Section } from "./sections/chat-l1";
import { ChatL2Section } from "./sections/chat-l2";
import { ChatL3Section } from "./sections/chat-l3";
import { ChatL4Section } from "./sections/chat-l4";

/**
 * demo chat 分区的冒烟测试：在无宿主环境下渲染 Chat L1–L4 四个分区，验证三条关键交互链路
 * （权限应答、外部注入提示词后发送、文案确实取自包内字典而非回落的 key）。
 *
 * 断言按「每一层只承载自己那一层的示例」写：分层重组最容易出的事故是示例搬错层或漏搬 ——
 * 前者由这里的正/反向断言暴露（例如 L4 不应再出现已下沉到 Base UI P3 的 Conversation 系列展示件），
 * 后者（import 指向已删除的旧模块）在 typecheck 阶段暴露。
 * 非 chat 分区见 `non-chat-sections-smoke.test.tsx`，侧栏装配见 `app-shell.test.tsx`。
 *
 * 与 `web/__tests__/mock-chat-store.test.tsx` 的分工：那边测 mock 与真实组件的契约，
 * 这边只保证 demo 分区本身可渲染、可交互，mock 的 props 契约漂移会在那边先暴露。
 * 依赖 happy-dom（根 package.json 已声明）：在文件顶部把 window/document 等灌进 globalThis。
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
// biome-ignore lint/suspicious/noExplicitAny: 同上（Resizable / 虚拟列表依赖 Node 判断）
(globalThis as any).Node = window.Node;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).HTMLElement = window.HTMLElement;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).Element = window.Element;
// biome-ignore lint/suspicious/noExplicitAny: 同上（命令菜单等浮层监听 pointer 事件）
(globalThis as any).Event = window.Event;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).MouseEvent = window.MouseEvent;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).CustomEvent = window.CustomEvent;
// biome-ignore lint/suspicious/noExplicitAny: 同上（图标与标记渲染）
(globalThis as any).SVGElement = window.SVGElement;
// biome-ignore lint/suspicious/noExplicitAny: 同上（happy-dom 的 requestAnimationFrame 绑定到它的 window）
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
// biome-ignore lint/suspicious/noExplicitAny: 同上（Switch 等表单控件做表单关联判断）
(globalThis as any).HTMLFormElement = window.HTMLFormElement;
// biome-ignore lint/suspicious/noExplicitAny: 同上（Resizable 读取面板尺寸时构造 DOMRect）
(globalThis as any).DOMRect = window.DOMRect;
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

describe("demo chat sections", () => {
  // L1 是外壳层：只应出现 ACPMain 全貌，消息流/输入岛/元件都应留在各自的 L 层。
  test("renders L1 session shell only", () => {
    act(() => root.render(<ChatL1Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Chat L1");
    expect(text).toContain("ACPMain");
    expect(text).not.toContain("ChatView（");
  });

  // L2 是主区层：会话列表、消息流与输入岛三块区域各有一组示例。
  test("renders L2 session list, message stream and composer", () => {
    act(() => root.render(<ChatL2Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Chat L2");
    expect(text).toContain("SidebarSessionList");
    expect(text).toContain("ChatView（");
    expect(text).toContain("ChatComposer（");
  });

  // L3 是元件层：气泡与消息部件、工具时间线、命令菜单与面板四组齐全。
  test("renders L3 bubbles, timeline, command menu and panels", () => {
    act(() => root.render(<ChatL3Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Chat L3");
    expect(text).toContain("UserBubble / AssistantBubble");
    expect(text).toContain("ToolCallGroup");
    expect(text).toContain("CommandMenu（");
    expect(text).toContain("PermissionPanel");
  });

  // L4 是消息基元层：只留必须认识会话交互形状的基元，已下沉到 Base UI P3 的展示件不应回落。
  // 这里比对示例组标题的完整清单 —— 只断言正文不含 CodeBlock 会误伤，示例文案本身就在讲这些组件。
  test("renders L4 message primitives without the pieces sunk into Base UI P3", () => {
    act(() => root.render(<ChatL4Section />));
    const text = container.textContent ?? "";
    expect(text).toContain("Chat L4");
    const titles = Array.from(container.querySelectorAll(".demo-example-title")).map((title) => title.textContent);
    expect(titles).toEqual(["PromptInput", "Reasoning", "Tool / PermissionRequest"]);
  });

  // 渲染后断言若干交互件的实际文案来自包内字典（而非回落的 key）。
  test("renders translated copy", () => {
    act(() => root.render(<ChatL3Section />));
    const text = container.textContent ?? "";
    expect(text).not.toContain("chat.components.");
    expect(text).not.toContain("chat.toolNarrator.");
  });

  // 权限应答：点击「允许一次」后请求从内存快照移除，面板与提示行同步变化。
  test("responding to a permission removes the card", () => {
    act(() => root.render(<ChatL3Section />));
    expect(container.textContent).toContain("Permission required");
    const allowButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("允许一次"),
    );
    expect(allowButton).toBeDefined();
    act(() => allowButton?.click());
    expect(container.textContent).toContain("权限已应答");
  });

  // 输入岛发送：通过 subscribeExternal 注入草稿后点击发送按钮，回调结果写回提示行。
  test("injected prompt + send button submits", () => {
    act(() => root.render(<ChatL2Section />));
    const injectButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("注入建议提示词"),
    );
    expect(injectButton).toBeDefined();
    act(() => injectButton?.click());
    const textareas = Array.from(container.querySelectorAll("textarea"));
    const draft = textareas.find((textarea) => textarea.value.includes("onPreviewFile"));
    expect(draft).toBeDefined();
    const send = container.querySelector(".chat-composer-send");
    expect(send).toBeDefined();
    act(() => (send as unknown as HTMLButtonElement).click());
    expect(container.textContent).toContain("已提交：用一句话说明 onPreviewFile 的宿主契约");
  });
});
