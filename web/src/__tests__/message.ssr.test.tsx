import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { Message, MessageContent, MessageResponse } from "../../components/ai-elements/message";

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
});
