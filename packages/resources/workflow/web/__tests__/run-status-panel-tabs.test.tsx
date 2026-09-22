// 运行面板的事件/输出页签：改造前是两个裸 <button> 手写 tab 条，没有 role="tablist"、没有 aria-selected，
// 屏幕阅读器读不出「页签」也读不出当前选中项。改用 @fenix/ui-components/ui/tabs（Radix 原语）后，本用例钉住
// 由此获得的语义契约、两个页签的文案与顺序，以及「只有激活面板挂载」这条受控行为，防止退回手写实现。
//
// 渲染走 react-dom/server（与 workflow-params-outputs-flow 同法）：这里验证的是结构契约，不需要 DOM 事件。

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import ReactDOMServer from "react-dom/server";
import type { RunStatusPanelProps } from "../pages/workflow/components/RunStatusPanel";

// 替身给的是跨包并集出口：bun 1.4.2 下 mock.module 的命名空间会被同进程后续文件复用，
// 只给本文件用到的出口会让之后加载的组件在渲染期取到 undefined。
mock.module("react-i18next", () => ({
  I18nextProvider: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

afterEach(() => {
  mock.restore();
});

async function renderPanel(overrides: Partial<RunStatusPanelProps> = {}): Promise<string> {
  const { RunStatusPanel } = await import("../pages/workflow/components/RunStatusPanel");
  const props: RunStatusPanelProps = {
    activeRunId: "run_1",
    runSnapshot: null,
    dagStatus: "RUNNING",
    isRunMode: true,
    isRunDone: false,
    running: true,
    runEvents: [],
    runApprovals: [],
    runRightTab: "events",
    setRunRightTab: () => {},
    selectedRunNodeId: null,
    setSelectedRunNodeId: () => {},
    selectedNodeOutput: null,
    nodeOutputLoading: false,
    handleCancelRun: async () => {},
    handleBackToEdit: () => {},
    handleBackToList: () => {},
    handleApprove: async () => {},
    handleRerunFrom: async () => {},
    setActiveRunId: () => {},
    setRunSnapshot: () => {},
    setRunEvents: () => {},
    setRunApprovals: () => {},
    setSelectedNodeOutput: () => {},
    updateNodesFromSnapshot: () => {},
    setRightTab: () => {},
    ...overrides,
  };
  return ReactDOMServer.renderToString(createElement(RunStatusPanel, props));
}

describe("RunStatusPanel 事件/输出页签", () => {
  // Radix 原语提供 tablist/tab 语义，选中项由 aria-selected 暴露——改造前的裸 button 两者都没有。
  test("页签带 tablist / tab 语义，选中项由 aria-selected 暴露", async () => {
    const html = await renderPanel();

    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)?.length).toBe(2);
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(html.match(/aria-selected="false"/g)?.length).toBe(1);
  });

  // 激活态跟随受控值：runRightTab 决定哪一个 tab 是 aria-selected="true"，且选中项是第一个页签。
  test("受控值决定激活页签", async () => {
    const activeTabOf = (html: string) => {
      const start = html.indexOf('aria-selected="true"');
      return html.slice(start, html.indexOf("</button>", start));
    };

    const events = activeTabOf(await renderPanel({ runRightTab: "events" }));
    expect(events).toContain("editor.events_tab");
    expect(events).not.toContain("editor.output_tab");

    const output = activeTabOf(await renderPanel({ runRightTab: "output" }));
    expect(output).toContain("editor.output_tab");
    expect(output).not.toContain("editor.events_tab");
  });

  // 文案与顺序沿用改造前：事件流在前、节点输出在后，且节点上下文只改第二个页签的文案。
  test("保留两个页签的文案与顺序", async () => {
    const html = await renderPanel();
    expect(html.indexOf("editor.events_tab")).toBeLessThan(html.indexOf("editor.output_tab"));

    const withNode = await renderPanel({ selectedRunNodeId: "custom_transform_1" });
    expect(withNode).toContain("editor.events_tab");
    expect(withNode).toContain("editor.output_tab_selected");
  });

  // 只有激活面板挂载（Radix 默认行为，等同改造前的条件渲染），未激活面板的事件流不应在 DOM 里。
  test("只渲染激活面板", async () => {
    const events = await renderPanel({ runRightTab: "events" });
    expect(events).toContain("editor.no_events");
    expect(events).not.toContain("editor.click_node_output");

    const output = await renderPanel({ runRightTab: "output" });
    expect(output).toContain("editor.click_node_output");
    expect(output).not.toContain("editor.no_events");
  });
});
