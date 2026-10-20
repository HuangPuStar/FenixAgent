import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import { ToolCallRow } from "../chat/timeline/ToolCallRow";
import type { ToolCallData } from "../chat/types";
import zh from "../i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * 工具行行内展开的交互测试。
 *
 * 契约：默认收起且不挂载详情；点击箭头展开 diff/输出；参数弹窗入口始终独立存在；
 * 没有可读内容时不出现展开箭头。
 */

const window = initializeHappyDomWindow(new Window());
/* biome-ignore lint/suspicious/noExplicitAny: 测试环境需要把 happy-dom 的 DOM 注入全局 */
(globalThis as any).window = window;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).document = window.document;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).navigator = window.navigator;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).HTMLElement = window.HTMLElement;
/* biome-ignore lint/suspicious/noExplicitAny: React 19 的 act 环境标记 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "zh",
  fallbackLng: "zh",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { zh: { [UI_COMPONENTS_NS]: zh } },
});

const DIFF_TOOL: ToolCallData = {
  id: "tool-diff",
  title: "Edit",
  kind: "edit",
  status: "complete",
  rawInput: { file_path: "src/app.ts" },
  content: [{ type: "diff", path: "src/app.ts", oldText: "const a = 1;", newText: "const a = 2;" }],
};

describe("工具行行内展开", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = window.document.createElement("div") as unknown as HTMLDivElement;
    window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.document.body.replaceChildren();
  });

  // diff 默认收起；展开后展示文件路径与变更行，参数弹窗入口保持独立。
  test("默认收起 diff，点击后展开并可再次收起", async () => {
    await act(async () => root.render(<ToolCallRow tool={DIFF_TOOL} />));

    const toggle = () => host.querySelector<HTMLButtonElement>('[data-slot="chat-tool-call-expand"]');
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[data-slot="chat-tool-call-body"]')).toBeNull();
    expect(host.querySelector('[data-slot="chat-tool-call-details-button"]')).not.toBeNull();

    await act(async () => toggle()?.click());

    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    const body = host.querySelector('[data-slot="chat-tool-call-body"]');
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("src/app.ts");
    expect(body?.textContent).toContain("const a = 1;");
    expect(body?.textContent).toContain("const a = 2;");

    await act(async () => toggle()?.click());
    expect(host.querySelector('[data-slot="chat-tool-call-body"]')).toBeNull();
  });

  // 终端输出走文本详情，展开后应保留换行与完整内容。
  test("展开终端输出文本", async () => {
    const tool: ToolCallData = {
      id: "tool-bash",
      title: "Bash",
      kind: "bash",
      status: "complete",
      rawOutput: { output: "first line\nsecond line" },
    };
    await act(async () => root.render(<ToolCallRow tool={tool} />));

    const toggle = host.querySelector<HTMLButtonElement>('[data-slot="chat-tool-call-expand"]');
    expect(toggle).not.toBeNull();
    await act(async () => toggle?.click());

    const text = host.querySelector('[data-slot="chat-tool-call-detail"]')?.textContent ?? "";
    expect(text).toContain("first line");
    expect(text).toContain("second line");
  });

  // 没有可读结果时不渲染展开箭头，避免伪交互；参数入口也不存在时整行保持纯展示。
  test("无可读内容时不渲染展开箭头", async () => {
    await act(async () =>
      root.render(<ToolCallRow tool={{ id: "tool-empty", title: "Bash", kind: "bash", status: "complete" }} />),
    );

    expect(host.querySelector('[data-slot="chat-tool-call-expand"]')).toBeNull();
  });
});
