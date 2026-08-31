import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { Message, MessageContent, MessageResponse } from "../../components/ai-elements/message";
import { AssistantBubble } from "../../components/chat/MessageBubble";
import { SubAgentPanel } from "../../components/chat/SubAgentPanel";
import { SystemMessage } from "../../components/chat/SystemMessage";

async function renderStreaming(element: ReactNode) {
  const stream = await renderToReadableStream(element);
  await stream.allReady;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let markup = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    markup += decoder.decode(value, { stream: true });
  }

  return markup + decoder.decode();
}

describe("消息组件的服务端渲染", () => {
  test("用户消息展示文本并使用用户角色样式", () => {
    const markup = renderToStaticMarkup(
      createElement(Message, { from: "user" }, createElement(MessageContent, null, "请总结这段内容")),
    );

    expect(markup).toContain("请总结这段内容");
    expect(markup).toStartWith(
      '<div class="group flex w-full max-w-[85%] min-w-0 flex-col gap-2 is-user ml-auto justify-end">',
    );
  });

  test("助手消息展示文本并使用助手角色样式", () => {
    const markup = renderToStaticMarkup(
      createElement(Message, { from: "assistant" }, createElement(MessageContent, null, "这是助手回复")),
    );

    expect(markup).toContain("这是助手回复");
    expect(markup).toContain("is-assistant");
    expect(markup).not.toContain("is-user ml-auto");
  });

  test("流式服务端渲染将 Markdown 转换为标题和强调内容", async () => {
    const markup = await renderStreaming(createElement(MessageResponse, null, "# 部署结果\n\n**验证通过**"));

    expect(markup).toContain('<h1 class="mt-6 mb-2 font-semibold text-3xl" data-streamdown="heading-1">部署结果</h1>');
    expect(markup).toContain('<span class="font-semibold" data-streamdown="strong">验证通过</span>');
  });

  // 失败消息必须展示稳定 Type 和 Error ID，避免所有故障都退化为“执行出错”。
  test("助手失败消息展示 Type、ID 和安全摘要", () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantBubble, {
        entry: {
          type: "assistant_message",
          id: "assistant-error",
          chunks: [],
          error: {
            type: "AGENT_RUNTIME.REQUEST_FAILED",
            id: "err_00000000000000000000000000000001",
            message: "The Agent request failed.",
          },
        },
      }),
    );

    expect(markup).toContain("Type: AGENT_RUNTIME.REQUEST_FAILED");
    expect(markup).toContain("ID: err_00000000000000000000000000000001");
    expect(markup).toContain("The Agent request failed.");
    expect(markup).not.toContain("errorArea.code");
    expect(markup).toContain("Agent request failed");
  });

  // 系统消息默认仅输出标签；原文仅在客户端双击触发的 Popover 中展示。
  test("系统消息默认不展示原始提示或浮层内容", () => {
    const markup = renderToStaticMarkup(
      createElement(SystemMessage, { rawText: "<system-reminder>仅双击后显示</system-reminder>" }),
    );

    expect(markup).toContain("messageBubble.systemMessage");
    expect(markup).not.toContain("仅双击后显示");
    expect(markup).not.toContain('data-slot="popover-content"');
  });

  // 子 Agent 详情默认折叠，只展示执行轨迹摘要，避免占满父工具调用。
  test("子 Agent 执行轨迹默认折叠", () => {
    const markup = renderToStaticMarkup(
      createElement(SubAgentPanel, {
        entries: [
          {
            type: "assistant_message",
            id: "sub-agent-message",
            chunks: [{ type: "message", text: "已完成调研" }],
          },
        ],
      }),
    );

    expect(markup).toContain("subAgentPanel.title");
    expect(markup).toContain("subAgentPanel.summary");
    expect(markup).not.toContain("已完成调研");
  });
});
