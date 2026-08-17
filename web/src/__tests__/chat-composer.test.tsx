import { describe, expect, test } from "bun:test";
import ReactDOMServer from "react-dom/server";

describe("ChatComposer", () => {
  test("exports as function", async () => {
    const mod = await import("../../components/chat/ChatComposer");
    expect(typeof mod.ChatComposer).toBe("function");
  });

  test("renders without envId (minimal props)", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    expect(() => {
      ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} />);
    }).not.toThrow();
  });

  test("renders textarea with placeholder", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} placeholder="给智能体发送消息…" />);
    expect(html).toContain("给智能体发送消息");
  });

  // 发送按钮现在是纯图标（无文字），检查 lucide Send 图标存在
  test("renders send button", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} />);
    expect(html).toContain("lucide-send");
  });

  // 元信息条：token 进度条宽度 + 百分比（数字文字已移除）
  test("renders token stats when tokenStats provided", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer
        onSubmit={() => {}}
        tokenStats={{ estimatedTokens: 12300, estimatedInputTokens: 5000, estimatedOutputTokens: 7300 }}
      />,
    );
    // 进度条 input token 宽度 2.5%（5000/200000）
    expect(html).toContain("width:2.5%");
    // React SSR 在 JSX 表达式和文本之间插入 HTML 注释（6<!-- -->%），需匹配 SSR 格式
    expect(html).toContain("6<!-- -->%");
  });

  // 元信息条：新会话按钮文案（i18n 未初始化时返回 key，参考 fde9e38 做法）
  test("renders new session button when showNewSession is true", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} showNewSession={true} onNewSession={() => {}} />,
    );
    expect(html).toContain("chatComposer.newSession");
  });

  // 浮动按钮组：技能按钮在有 commands 和 envId 时渲染
  test("renders skill and file buttons when commands and envId provided", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const mockCommands = [
      { name: "review", description: "Code review" },
      { name: "test", description: "Run tests" },
    ];
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} commands={mockCommands} envId="env_test" />,
    );
    // 检查技能按钮存在（SSR 下 i18n 回退到 key）
    expect(html).toContain("chatComposer.skillButton");
    // 检查文件按钮存在
    expect(html).toContain("chatComposer.fileButton");
  });

  // 浮动按钮组：仅有 commands 无 envId 时，只有技能按钮
  test("renders only skill button when no envId", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const mockCommands = [{ name: "review", description: "Code review" }];
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} commands={mockCommands} />);
    expect(html).toContain("chatComposer.skillButton");
    expect(html).not.toContain("chatComposer.fileButton");
  });

  // 浮动按钮组：仅有 envId 无 commands 时，只有文件按钮
  test("renders only file button when no commands", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} envId="env_test" />);
    expect(html).not.toContain("chatComposer.skillButton");
    expect(html).toContain("chatComposer.fileButton");
  });

  // 浮动按钮组：commands 为空数组时不显示技能按钮，无 envId 时不显示文件按钮
  test("renders no buttons when commands empty array and no envId", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} commands={[]} />);
    expect(html).not.toContain("chatComposer.skillButton");
    expect(html).not.toContain("chatComposer.fileButton");
  });

  // 断点 1 修复：canCancel（accepting/running/awaiting_permission）时按钮渲染 Square 停止图标，
  // 输出过程中（running，loading 非空但 canCancel=true）停止按钮也必须可见
  test("renders Square stop icon when canCancel is true", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} canCancel={true} onInterrupt={() => {}} />,
    );
    expect(html).toContain("lucide-square");
    expect(html).not.toContain("lucide-send");
  });

  // canCancel 时停止按钮可点击（不带 disabled）——running 输出期间可随时中断
  test("stop button is enabled when canCancel is true", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} canCancel={true} onInterrupt={() => {}} />,
    );
    expect(html).not.toContain('disabled=""');
  });

  // cancelling（isLoading 且 canCancel=false）：渲染 Square 且 disabled，防止重复点发重取消
  test("renders disabled Square when isLoading and canCancel is false (cancelling)", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} isLoading={true} canCancel={false} onInterrupt={() => {}} />,
    );
    expect(html).toContain("lucide-square");
    expect(html).toContain('disabled=""');
  });

  // 默认状态（无 canCancel/isLoading）渲染 Send 图标——回归保护，与既有行为一致
  test("renders Send icon by default", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} />);
    expect(html).toContain("lucide-send");
    expect(html).not.toContain("lucide-square");
  });
});

// ── 交互测试（happy-dom + react-dom/client）──
// 补 P2-5：SSR 字符串断言只验证了渲染结果，未覆盖 onClick 分支。
// 以下用例直接渲染并点击按钮，验证 canCancel 时点击走 onInterrupt 而非 handleSubmit。

import { expect as domExpect, test as domTest } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/** ChatComposer 的 props 类型（类型空间 import，不产生运行时加载） */
type ComposerProps = Parameters<typeof import("../../components/chat/ChatComposer")["ChatComposer"]>[0];

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 设置最小 DOM 环境（react-dom/client 在 CI CJS 构建下模块加载时需要 window）
const win = new Window();
const g = globalThis as Record<string, unknown>;
if (!g.window) g.window = win;
if (!g.document) g.document = win.document;
if (!g.navigator) g.navigator = win.navigator;
// happy-dom querySelectorAll 选择器解析需要 window.SyntaxError（workflow-runs-page.test.tsx 同款处理）
if (!(win as unknown as Record<string, unknown>).SyntaxError) {
  (win as unknown as Record<string, unknown>).SyntaxError = SyntaxError;
}

/** 客户端渲染 ChatComposer，返回容器与卸载函数 */
async function renderComposer(props: ComposerProps): Promise<{
  container: HTMLElement;
  unmount: () => void;
}> {
  const { ChatComposer } = await import("../../components/chat/ChatComposer");
  const container = win.document.createElement("div");
  const root: Root = createRoot(container as unknown as HTMLElement);
  act(() => {
    root.render(createElement(ChatComposer, props));
  });
  return { container: container as unknown as HTMLElement, unmount: () => act(() => root.unmount()) };
}

/** 找到发送/停止按钮（含 lucide 图标的 button） */
function findActionButton(container: HTMLElement): HTMLElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((b) =>
      b.querySelector("svg.lucide-send, svg.lucide-square"),
    ) ?? null
  );
}

describe("ChatComposer interaction", () => {
  // canCancel（running 输出中）时点击按钮：只触发 onInterrupt，不触发 onSubmit——
  // 这是断点 1 的核心交互：输出期间点停止必须走取消链路而不是重发消息
  domTest("click calls onInterrupt when canCancel is true", async () => {
    let submitCalls = 0;
    let interruptCalls = 0;
    const { container, unmount } = await renderComposer({
      onSubmit: () => {
        submitCalls += 1;
      },
      onInterrupt: () => {
        interruptCalls += 1;
      },
      canCancel: true,
    });
    try {
      const button = findActionButton(container);
      domExpect(button).not.toBeNull();
      domExpect(button?.querySelector("svg.lucide-square")).not.toBeNull();
      act(() => {
        button?.click();
      });
      domExpect(interruptCalls).toBe(1);
      domExpect(submitCalls).toBe(0);
    } finally {
      unmount();
    }
  });

  // cancelling（isLoading 且 canCancel=false，取消已发出）时按钮禁用：
  // 点击无任何动作，防止重复点触发无意义的重发 cancel RPC
  domTest("click is no-op when cancelling (isLoading && !canCancel)", async () => {
    let submitCalls = 0;
    let interruptCalls = 0;
    const { container, unmount } = await renderComposer({
      onSubmit: () => {
        submitCalls += 1;
      },
      onInterrupt: () => {
        interruptCalls += 1;
      },
      isLoading: true,
      canCancel: false,
    });
    try {
      const button = findActionButton(container);
      domExpect(button).not.toBeNull();
      domExpect(button?.hasAttribute("disabled")).toBe(true);
      act(() => {
        button?.click();
      });
      domExpect(interruptCalls).toBe(0);
      domExpect(submitCalls).toBe(0);
    } finally {
      unmount();
    }
  });
});
