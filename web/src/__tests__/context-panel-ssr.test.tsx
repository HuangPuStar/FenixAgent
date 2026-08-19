import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

import { ContextPanel } from "../../components/ContextPanel";
import i18n from "../i18n";
import type { ThreadEntry } from "../lib/types";

function renderPanel(entries: ThreadEntry[], collapsed = false) {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ContextPanel, {
        entries,
        agentName: "env_abcdefghijklmnopqrst",
        modelName: "claude-test",
        duration: "12s",
        collapsed,
        onToggle: () => {},
      }),
    ),
  );
}

describe("ContextPanel 服务端渲染", () => {
  // 没有工具调用的会话仍应展示稳定的统计与空状态，避免空面板崩溃。
  test("空会话展示工具空态与模型信息", () => {
    const html = renderPanel([]);

    expect(html).toContain("claude-test");
    expect(html).toContain("12s");
    expect(html).toContain("contextPanel.noToolCalls");
    expect(html).toContain("0 / 200k");
  });

  // 工具调用应按规范名称合并计数，并将待确认调用展示在权限队列中。
  test("工具调用渲染聚合计数与待确认队列", () => {
    const entries: ThreadEntry[] = [
      { type: "user_message", id: "user-1", content: "部署服务" },
      {
        type: "assistant_message",
        id: "assistant-1",
        chunks: [{ type: "message", text: "正在处理" }],
      },
      {
        type: "tool_call",
        toolCall: {
          id: "tool-1",
          title: "Bash 执行部署",
          status: "complete",
          rawOutput: { status: "ok" },
        },
      },
      {
        type: "tool_call",
        toolCall: {
          id: "tool-2",
          title: "Read 配置",
          status: "waiting_for_confirmation",
        },
      },
      {
        type: "tool_call",
        toolCall: {
          id: "tool-3",
          title: "Bash 查看日志",
          status: "complete",
        },
      },
    ];
    const html = renderPanel(entries);

    expect(html).toContain("bash");
    expect(html).toContain("read");
    expect(html).toContain("Read 配置");
    expect(html).toContain("contextPanel.pendingConfirmation");
    expect(html).toContain(">2</span>");
  });

  // ACP 用量存在时必须优先展示服务端报告的 token，而不是客户端字符估算值。
  test("ACP 用量优先于本地估算", () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(ContextPanel, {
          entries: [{ type: "user_message", id: "user-1", content: "短消息" }],
          collapsed: false,
          onToggle: () => {},
          acpUsage: { totalTokens: 2500, inputTokens: 1500, outputTokens: 1000 },
        }),
      ),
    );

    expect(html).toContain("2.5k / 200k");
    expect(html).toContain("1.5k");
    expect(html).toContain("1.0k");
  });

  // 收起面板仍保留切换控件，但内容容器必须进入不可交互的折叠状态。
  test("收起状态保留切换控件并禁用面板交互", () => {
    const html = renderPanel([], true);

    expect(html).toContain("!w-0 opacity-0 !border-l-0 pointer-events-none");
    expect(html).toContain("contextPanel.showContext");
  });
});
