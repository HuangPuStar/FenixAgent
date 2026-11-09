import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const globals = globalThis as Record<string, unknown>;
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
  "customElements",
  "IS_REACT_ACT_ENVIRONMENT",
];
const saved = new Map(keys.map((key) => [key, globals[key]]));
const win = initializeHappyDomWindow(new Window());
Object.assign(globals, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Element: win.Element,
  Node: win.Node,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  customElements: win.customElements,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { FileViewerPreview } = await import("../components/preview/FileViewerPreview");
const i18n = createInstance();
void i18n.init({
  lng: "en",
  initAsync: false,
  defaultNS: UI_COMPONENTS_NS,
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  win.document.body.replaceChildren();
});
afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

/** 真实预览组件加载内存文件；保留原始文件名，避免依赖外部文件服务器。 */
async function mount(filePath: string, content = "order,amount\nA001,123") {
  const host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  root = createRoot(host);
  const url = `data:text/plain,${encodeURIComponent(content)}`;
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <FileViewerPreview
          envId="env-1"
          filePath={filePath}
          buildPreviewUrl={() => url}
          fetchPreview={async () => new Response(content)}
        />
      </I18nextProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return host;
}

describe("特殊文件名预览", () => {
  // 普通文件名与含 #、?、% 的文件名必须创建相同的 PDF 查看器，显示名保持原样。
  test.each([
    "工单123分析报告.pdf",
    "工单#123分析报告.pdf",
    "工单?123分析报告.PDF",
    "工单%23123分析报告.pdf",
  ])("PDF %s 创建原生查看器", async (name) => {
    const host = await mount(`user/${name}`);
    const frame = host.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.title).toBe(name);
    expect(frame?.src).toStartWith("data:");
  });

  // 表格预览既要选中 office 插件，也要把正确扩展名传给其渲染分支。
  test.each([
    "订单20261105明细.csv",
    "订单#20261105明细.csv",
    "订单?20261105明细.csv",
  ])("CSV %s 展示表格数据", async (name) => {
    const host = await mount(`user/${name}`);
    for (let attempt = 0; attempt < 40 && !host.querySelector("table"); attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(host.querySelector("table"), host.textContent ?? "").not.toBeNull();
    expect(host.textContent).toContain("A001");
    expect(host.textContent).toContain("123");
  });

  // HTML 需要渲染入口且保留原文件名与沙箱，不能只退化成源码。
  test.each([
    "测试报告025.html",
    "测试报告#025.html",
    "测试报告?025.htm",
  ])("HTML %s 提供渲染和源码入口", async (name) => {
    const host = await mount(`user/${name}`, "<h1>REPORT_025</h1>");
    expect(host.querySelector("iframe")?.title).toBe(name);
    expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(host.textContent).toContain("渲染预览");
    expect(host.textContent).toContain("源码");
  });
});
