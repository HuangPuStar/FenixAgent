// web/__tests__/openui-message.test.tsx
// OpenUI 围栏在消息正文里的接线契约：完整围栏渲染成 SDK 组件、坏程序/多围栏/历史 ui-spec 围栏
// 都退回普通 Markdown、流式未闭合给骨架，以及按钮动作经宿主 Context 发出 `continue_conversation`。
//
// 断言全部走 `MessageResponse` 的生产路径（`splitOpenUI` → 懒加载 renderer），不 mock 模块。
// happy-dom 骨架沿用 `chat-math-rendering.test.tsx`；OpenUI 主题桥在模块求值时调用
// `getComputedStyle` 与 `MutationObserver`，因此这两个全局必须一并注入并成对还原。

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import type { OpenUIActionEvent } from "@peri-code/sdk/openui";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, lazy, type ReactNode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";
import { type OpenUIActionHandler, OpenUIActionProvider } from "../chat/openui/action-context";
import { OpenUIChunkErrorBoundary } from "../chat/openui/openui-block";
import { MessageResponse } from "../chat/primitives/message";
import { type ChatInputSubmitOptions, useChatInputSubmit } from "../chat/shell/internal/use-chat-input-submit";
import type { ChatInputMessage } from "../chat/types";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const win = initializeHappyDomWindow(new Window());
const savedGlobals: Record<string, PropertyDescriptor | undefined> = {};

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

const INJECTED_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "customElements",
  "ResizeObserver",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

beforeAll(() => {
  for (const key of INJECTED_GLOBALS) savedGlobals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  const injected: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    customElements: win.customElements,
    ResizeObserver: win.ResizeObserver,
    // SDK 主题桥无条件构造 MutationObserver、读取计算样式；缺失会在懒 chunk 求值期直接抛错。
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(injected)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterAll(() => {
  for (const key of INJECTED_GLOBALS) {
    const descriptor = savedGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  win.document.body.replaceChildren();
});

const mounted: Root[] = [];

afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
  win.document.body.replaceChildren();
});

/** 逐个事件循环推进，让惰性模块（streamdown、OpenUI renderer）落地。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 等某个标记出现再断言：两条渲染器都是动态导入的，同步渲染只能拿到兜底内容。 */
async function waitFor(host: HTMLElement, selector: string): Promise<Element> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const found = host.querySelector(selector);
    if (found) return found;
    await flush();
  }
  throw new Error(`等待 ${selector} 超时（惰性模块未落地）`);
}

interface RenderOptions {
  isStreaming?: boolean;
  handler?: OpenUIActionHandler;
}

/** 渲染一条助手正文；`handler` 存在时外套 `OpenUIActionProvider`（生产接线形如 ChatInterface）。 */
async function renderMessage(markdown: string, options: RenderOptions = {}): Promise<HTMLElement> {
  const host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  const root = createRoot(host);
  mounted.push(root);

  const message = (
    <MessageResponse isStreaming={options.isStreaming ?? false} mode={options.isStreaming ? "streaming" : "static"}>
      {markdown}
    </MessageResponse>
  );
  const element: ReactNode = options.handler ? (
    <OpenUIActionProvider value={options.handler}>{message}</OpenUIActionProvider>
  ) : (
    message
  );

  act(() => root.render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>));
  return host;
}

const fence = (program: string) => `\`\`\`openui\n${program}\n\`\`\``;

const VALID_PROGRAM = ["root = Stack([title])", 'title = H2("OpenUI 渲染成功")'].join("\n");

const ACTION_PROGRAM = [
  "root = Stack([actions])",
  'actions = Row([more], 8, "end", "end")',
  'more = Button("继续分析", @ToAssistant("继续分析这张图"), "secondary")',
].join("\n");

describe("OpenUI 围栏渲染", () => {
  // 完整围栏必须交给 SDK 组件渲染：出现 peri-openui 容器与组件正文，且原始程序文本不再显示
  test("完整围栏渲染为 OpenUI 组件且不显示原始程序", async () => {
    const host = await renderMessage(fence(VALID_PROGRAM));
    const container = await waitFor(host, '[data-slot="peri-openui"]');

    expect(container.textContent).toContain("OpenUI 渲染成功");
    expect(host.textContent).not.toContain("root = Stack");
  });

  // 前后文分片只占宽度：高度 100% 会让每个片段各自撑满容器，把面板顶出视口
  test("围栏前后分片不携带撑满高度的 size-full", async () => {
    const host = await renderMessage(`前言文字\n\n${fence(VALID_PROGRAM)}\n\n后记文字`);
    await waitFor(host, '[data-slot="peri-openui"]');
    // 分片与面板各自惰性加载，等 Markdown 容器真正落地后再断言。
    await waitFor(host, ".message-response");

    const fragments = Array.from(host.querySelectorAll(".message-response"));
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.some((fragment) => fragment.classList.contains("size-full"))).toBe(false);
  });

  // 坏程序（引用不存在的节点）不能吞掉模型输出：出现回退标记，原文仍可见，渲染不抛错
  test("非法程序回退原文并标记 data-openui-fallback", async () => {
    const program = "root = Stack([missing])";
    const host = await renderMessage(fence(program));
    const fallback = await waitFor(host, "[data-openui-fallback]");

    expect(fallback.textContent).toContain(program);
    expect(host.querySelector('[data-slot="peri-openui"]')).toBeNull();
  });

  // 多个围栏无法确定该渲染哪一个：按普通 Markdown 代码块处理，不能出现 OpenUI 容器
  test("两个围栏整体回退为 Markdown 代码块", async () => {
    const host = await renderMessage(`${fence(VALID_PROGRAM)}\n\n${fence(VALID_PROGRAM)}`);
    await waitFor(host, '[data-streamdown="code-block"]');

    expect(host.querySelector('[data-slot="peri-openui"]')).toBeNull();
    expect(host.textContent).toContain("root = Stack");
  });

  // 历史消息里的 ```ui-spec 围栏只当普通代码块（旧实现已删除），不得再有 ui-spec 组件痕迹
  test("历史 ui-spec 围栏按普通代码块渲染", async () => {
    const legacy = '```ui-spec\n{"version":1,"root":"text","elements":{}}\n```';
    const host = await renderMessage(legacy);
    await waitFor(host, '[data-streamdown="code-block"]');

    expect(host.querySelector('[data-slot="peri-openui"]')).toBeNull();
    expect(host.textContent).toContain('"version":1');
  });

  // 流式未闭合围栏是正常中间态：SDK 在程序可解析前给骨架，不把半截程序当 Markdown 代码块
  test("流式未闭合围栏显示 OpenUI 骨架", async () => {
    const host = await renderMessage("```openui\nroot = Stack(", { isStreaming: true });
    await waitFor(host, '[data-slot="peri-openui-skeleton"]');
  });
});

describe("OpenUI 按钮动作", () => {
  // 点击按钮把 humanFriendlyMessage 作为用户消息发出去：事件类型是 continue_conversation
  test("点击动作按钮触发 continue_conversation 事件", async () => {
    const events: OpenUIActionEvent[] = [];
    const host = await renderMessage(fence(ACTION_PROGRAM), {
      handler: { enabled: true, send: (event) => events.push(event) },
    });
    await waitFor(host, '[data-slot="peri-openui"]');

    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("continue_conversation");
    expect(events[0]?.humanFriendlyMessage).toBe("继续分析这张图");
  });

  // 没有宿主 Context 时动作整体禁用：按钮 disabled，点击不会产生任何发送副作用
  test("无承载 Context 时按钮禁用", async () => {
    const host = await renderMessage(fence(ACTION_PROGRAM));
    await waitFor(host, '[data-slot="peri-openui"]');

    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});

describe("OpenUI 渲染器 chunk 加载失败", () => {
  // chunk 在求值期拒绝时，静态图里的 boundary 必须就地回退原文，而不是把错误抛到消息级边界
  test("懒加载 chunk 失败时渲染原文兜底", async () => {
    const RejectingChunk = lazy(() => Promise.reject(new Error("chunk load failed")));
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const host = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
    const root = createRoot(host);
    mounted.push(root);

    try {
      act(() => {
        root.render(
          <OpenUIChunkErrorBoundary fallback={<div>原始正文兜底</div>}>
            <Suspense fallback={<div>加载中</div>}>
              <RejectingChunk />
            </Suspense>
          </OpenUIChunkErrorBoundary>,
        );
      });

      const fallback = await waitFor(host, '[data-openui-fallback="chunk-load-error"]');
      expect(fallback.textContent).toBe("原始正文兜底");
      expect(host.textContent).not.toContain("加载中");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

/** 可控 promise：用于让直发停在「在途」状态，观察第二次提交是否被守卫拦下。 */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const BASE_SUBMIT_OPTIONS: ChatInputSubmitOptions = {
  isLoading: false,
  activeSessionId: "session-a",
  onCreateSession: async () => "session-a",
  onSendPrompt: async () => {},
  imagePrepareFailedMessage: "image-failed",
  sessionCreateFailedMessage: "session-failed",
  sendPromptFailedMessage: "send-failed",
};

/** 极简 hook 宿主：把最新的 `submit` 交给测试，不渲染任何 DOM。 */
function SubmitHarness({
  options,
  capture,
}: {
  options: Partial<ChatInputSubmitOptions>;
  capture: (submit: (message: ChatInputMessage) => Promise<void>) => void;
}) {
  const submit = useChatInputSubmit({ ...BASE_SUBMIT_OPTIONS, ...options });
  capture(submit);
  return null;
}

/** 建一个只挂 harness 的 root，返回触发提交的句柄。 */
async function mountSubmitHarness(options: Partial<ChatInputSubmitOptions>): Promise<{
  submit: (message: ChatInputMessage) => Promise<void>;
  host: HTMLElement;
}> {
  const host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  const root = createRoot(host);
  mounted.push(root);
  let submit: ((message: ChatInputMessage) => Promise<void>) | null = null;
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <SubmitHarness
          capture={(next) => {
            submit = next;
          }}
          options={options}
        />
      </I18nextProvider>,
    );
  });
  if (!submit) throw new Error("submit 未挂载");
  return { submit, host };
}

describe("OpenUI 动作的重复直发保护", () => {
  // 快速双击时第二次提交必须被同步守卫丢弃：第一次直发落定前不能再调用 onSendPrompt
  test("直发在途时第二次提交不再发送", async () => {
    const deferred = createDeferred();
    let sends = 0;
    const { submit } = await mountSubmitHarness({
      onSendPrompt: () => {
        sends += 1;
        return deferred.promise;
      },
    });

    await act(async () => {
      void submit({ text: "第一次" });
      void submit({ text: "第二次" });
      await Promise.resolve();
    });
    expect(sends).toBe(1);

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });
    await flush();

    await act(async () => {
      await submit({ text: "第三次" });
    });
    expect(sends).toBe(2);
  });

  // 入队路径不受直发守卫影响：turn 运行中连续提交两次都应该入队
  test("入队路径不被直发守卫拦截", async () => {
    const enqueued: string[] = [];
    let sends = 0;
    const { submit } = await mountSubmitHarness({
      isLoading: true,
      queueSubmitActive: true,
      onEnqueuePrompt: (_blocks, draft) => {
        enqueued.push(draft);
        return true;
      },
      onSendPrompt: async () => {
        sends += 1;
      },
    });

    await act(async () => {
      void submit({ text: "入队一" });
      void submit({ text: "入队二" });
      await Promise.resolve();
    });

    expect(enqueued).toEqual(["入队一", "入队二"]);
    expect(sends).toBe(0);
  });
});
