// 通道页「创建」入口的弹窗回归：空态分支提前 return，弹窗若只挂在有数据分支，点击后只改 state、界面无反应。
//
// Radix Dialog 在模块加载时探测 DOM，必须先把 happy-dom 装进全局再动态导入页面；同进程里其他用例可能
// 已先加载 Radix，因此这条真实 DOM 交互放到子进程里跑，避免首载结果被别人的全局状态决定。

import { expect, test } from "bun:test";

if (process.env.FENIX_CHANNEL_DIALOG_TEST_CHILD !== "1") {
  test("通道页创建弹窗回归", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, FENIX_CHANNEL_DIALOG_TEST_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`通道页弹窗测试失败 (${code})\n${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 30000);
} else {
  const { initializeHappyDomWindow } = await import("@fenix/ui-components/testing");
  const { Window } = await import("happy-dom");

  const window = initializeHappyDomWindow(new Window());
  const globalRecord = globalThis as Record<string, unknown>;
  globalRecord.window = window;
  globalRecord.document = window.document;
  globalRecord.navigator = window.navigator;
  globalRecord.HTMLElement = window.HTMLElement;
  globalRecord.HTMLInputElement = window.HTMLInputElement;
  globalRecord.Node = window.Node;
  globalRecord.Element = window.Element;
  // Radix Select 在 layout effect 里用 DocumentFragment 承载隐藏内容，缺这个全局会直接抛错。
  globalRecord.DocumentFragment = window.DocumentFragment;
  globalRecord.Event = window.Event;
  globalRecord.CustomEvent = window.CustomEvent;
  globalRecord.MouseEvent = window.MouseEvent;
  globalRecord.KeyboardEvent = window.KeyboardEvent;
  globalRecord.MutationObserver = window.MutationObserver;
  globalRecord.ResizeObserver = window.ResizeObserver;
  globalRecord.customElements = window.customElements;
  globalRecord.getComputedStyle = window.getComputedStyle.bind(window);
  globalRecord.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalRecord.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalRecord.IS_REACT_ACT_ENVIRONMENT = true;

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createInstance } = await import("i18next");
  const { I18nextProvider } = await import("react-i18next");
  const { initReactI18next } = await import("react-i18next/initReactI18next");
  const { uiComponentsResources } = await import("@fenix/ui-components/i18n");
  const { UI_COMPONENTS_NS } = await import("@fenix/ui-components/i18n/namespace");
  const { AgentChannelsPage, CHANNELS_NS, channelsResources } = await import("@fenix/resource-channel/web");

  const i18n = createInstance();
  void i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    ns: [CHANNELS_NS, UI_COMPONENTS_NS],
    defaultNS: CHANNELS_NS,
    initAsync: false,
    interpolation: { escapeValue: false },
    resources: {
      en: {
        [CHANNELS_NS]: channelsResources.en,
        [UI_COMPONENTS_NS]: uiComponentsResources.en,
      },
    },
  });

  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  // 业务意图：空态必须真的能打开创建表单，否则用户无从建立第一条通道（此前弹窗只挂在有数据分支）。
  test("空态点击创建入口打开通道表单", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    console.error = () => {};

    const host = window.document.createElement("div") as unknown as HTMLDivElement;
    window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <AgentChannelsPage />
        </I18nextProvider>,
      );
    });
    await flush();

    const create = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(channelsResources.en.langbot.bots.create),
    );
    expect(create).toBeDefined();

    await act(async () => {
      create?.click();
    });
    await flush();

    const dialog = window.document.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector("input")).not.toBeNull();

    act(() => root.unmount());
    window.document.body.replaceChildren();
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });
}
