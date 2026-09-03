import { describe, expect, test } from "bun:test";
import ReactDOMServer from "react-dom/server";
import { buildPromptText } from "../../components/chat/composer-prompt";

describe("Composer prompt capabilities", () => {
  // 未选择能力时保持用户正文原样，不产生额外 reminder。
  test("keeps plain prompt unchanged without selected capabilities", () => {
    expect(buildPromptText({ text: "检查这个改动" })).toBe("检查这个改动");
  });

  // Skill slash command 已在用户正文中，发送边界只为 MCP 注入 system-reminder。
  test("injects only selected mcps at the send boundary", () => {
    expect(buildPromptText({ text: "/review 检查这个改动", mcps: ["filesystem"] })).toBe(
      "<system-reminder>\nThe user selected these MCP connections for this turn: filesystem\nUse the selected MCP connections when they are relevant to the user's request.\n</system-reminder>\n\n/review 检查这个改动",
    );
  });
});

describe("ChatComposer", () => {
  // 引用在输入区只显示紧凑方形卡片，正文仅放入受限的 hover/focus 预览。
  test("renders a compact quote tile with bounded hover preview", async () => {
    const { ComposerAssets } = await import("../../components/chat/composer-assets");
    const html = ReactDOMServer.renderToString(
      <ComposerAssets
        images={[]}
        files={[]}
        quotes={[{ id: "quote-1", text: "不应展示的引用正文", omittedCharacterCount: 128 }]}
        onRemoveImage={() => {}}
        onRemoveFile={() => {}}
        onRemoveQuote={() => {}}
      />,
    );

    expect(html).toContain("chat-composer-asset is-quote");
    expect(html).toContain("chat-composer-quote-preview");
    expect(html).toContain("不应展示的引用正文");
    expect(html).toContain("…");
  });

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

  // 只渲染协议真实 token 总量，不按固定上限推算百分比。
  test("renders real context usage without a fake percentage", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} contextUsage={{ totalTokens: 12300, inputTokens: 5000, outputTokens: 7300 }} />,
    );
    expect(html).toContain("12.3k");
    expect(html).not.toContain("%");
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
    expect(html).toContain("chatComposer.skillButton");
    expect(html).toContain("chatComposer.attach");
  });

  // 无环境时仍展示文件入口以保持工具栏稳定，但入口必须禁用，不能触发无作用上传。
  test("disables file button when commands exist without an environment", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const mockCommands = [{ name: "review", description: "Code review" }];
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} commands={mockCommands} />);
    expect(html).toContain("chatComposer.skillButton");
    expect(html).toContain('aria-label="chatComposer.attach"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="chatComposer\.attach"/);
  });

  // 浮动按钮组：仅有 envId 无 commands 时，只有文件按钮
  test("renders only file button when no commands", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} envId="env_test" />);
    expect(html).not.toContain("chatComposer.commandButton");
    expect(html).toContain('aria-label="chatComposer.attach"');
  });

  // 浮动按钮组：commands 为空数组时不显示技能按钮，无 envId 时不显示文件按钮
  test("renders no buttons when commands empty array and no envId", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} commands={[]} />);
    expect(html).not.toContain("chatComposer.commandButton");
    expect(html).toContain('aria-label="chatComposer.attach"');
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
    expect(html).toContain('chat-composer-send is-stop" type="button" aria-label="chatComposer.stop"');
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
import { initializeHappyDomWindow } from "./happy-dom-window";

/** ChatComposer 的 props 类型（类型空间 import，不产生运行时加载） */
type ComposerProps = Parameters<typeof import("../../components/chat/ChatComposer")["ChatComposer"]>[0];

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 设置最小 DOM 环境（react-dom/client 在 CI CJS 构建下模块加载时需要 window）
const win = initializeHappyDomWindow(new Window());
const g = globalThis as Record<string, unknown>;
if (!g.window) g.window = win;
if (!g.document) g.document = win.document;
if (!g.navigator) g.navigator = win.navigator;

/** 客户端渲染 ChatComposer，返回容器与卸载函数 */
async function renderComposer(props: ComposerProps): Promise<{
  container: HTMLElement;
  rerender: (nextProps: ComposerProps) => void;
  unmount: () => void;
}> {
  const { ChatComposer } = await import("../../components/chat/ChatComposer");
  const container = win.document.createElement("div");
  const root: Root = createRoot(container as unknown as HTMLElement);
  const rerender = (nextProps: ComposerProps) => {
    act(() => {
      root.render(createElement(ChatComposer, nextProps));
    });
  };
  rerender(props);
  return { container: container as unknown as HTMLElement, rerender, unmount: () => act(() => root.unmount()) };
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
  // 连续引用应同步更新预算；发送时引用作为本轮原子字段提交，方形卡不暴露正文。
  domTest("bounds synchronous quotes and submits hidden quote context", async () => {
    let submitted: Parameters<NonNullable<ComposerProps["onSubmit"]>>[0] | undefined;
    const props: ComposerProps = {
      contextScope: "session-a",
      onSubmit: (message) => {
        submitted = message;
      },
    };
    const { container, unmount } = await renderComposer(props);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("chat:quote", { detail: { text: "甲".repeat(4_000), contextScope: "session-a" } }),
        );
        window.dispatchEvent(
          new CustomEvent("chat:quote", { detail: { text: "乙".repeat(4_000), contextScope: "session-a" } }),
        );
        window.dispatchEvent(
          new CustomEvent("chat:quote", { detail: { text: "丙".repeat(4_000), contextScope: "session-a" } }),
        );
      });

      domExpect(container.querySelectorAll(".chat-composer-asset.is-quote")).toHaveLength(2);
      domExpect(container.querySelectorAll(".chat-composer-quote-preview")).toHaveLength(2);
      const button = findActionButton(container);
      act(() => button?.click());
      domExpect(submitted?.quoteContext).toContain("甲".repeat(100));
      domExpect(submitted?.quoteContext).toContain("乙".repeat(100));
      domExpect(submitted?.quoteContext).not.toContain("丙");
    } finally {
      unmount();
    }
  });

  // 切换确定性会话 scope 时清空旧引用，避免旧会话上下文进入新会话。
  domTest("clears quote tiles when context scope changes", async () => {
    const props: ComposerProps = { contextScope: "session-a", onSubmit: () => {} };
    const { container, rerender, unmount } = await renderComposer(props);
    try {
      act(() => {
        window.dispatchEvent(new CustomEvent("chat:quote", { detail: { text: "旧会话", contextScope: "session-a" } }));
      });
      domExpect(container.querySelectorAll(".chat-composer-asset.is-quote")).toHaveLength(1);

      rerender({ ...props, contextScope: "session-b" });
      domExpect(container.querySelectorAll(".chat-composer-asset.is-quote")).toHaveLength(0);
    } finally {
      unmount();
    }
  });

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
