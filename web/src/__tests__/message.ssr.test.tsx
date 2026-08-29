import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { Message, MessageContent, MessageResponse } from "../../components/ai-elements/message";
import { AssistantBubble, UserBubble } from "../../components/chat/MessageBubble";
import { SubAgentPanel } from "../../components/chat/SubAgentPanel";
import { SystemMessage } from "../../components/chat/SystemMessage";
import componentsEN from "../i18n/locales/en/components.json";
import componentsZH from "../i18n/locales/zh/components.json";

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

  // 生产用户气泡必须保留作者输入的换行，并挂载不会被长路径撑破的内容样式契约。
  test("用户气泡保留换行并启用长文本换行样式", () => {
    const content =
      "/Users/demo/workspaces/organization/environment/this-is-a-very-long-directory-name-without-spaces/output.md\n请继续检查";
    const markup = renderToStaticMarkup(
      createElement(UserBubble, {
        entry: { type: "user_message", id: "long-user-prompt", content },
      }),
    );

    expect(markup).toContain("chat-user-message-frame");
    expect(markup).toContain("chat-user-message-content");
    expect(markup).toContain("output.md\n请继续检查");
  });

  // 发送后的文件引用应恢复为附件 pill，而不是继续显示为普通裸文本。
  test("用户气泡将文件引用渲染为附件语义", () => {
    const markup = renderToStaticMarkup(
      createElement(UserBubble, {
        entry: { type: "user_message", id: "file-reference", content: "请检查\n@./src/report.md" },
      }),
    );

    expect(markup).toContain('data-file-attachment="src/report.md"');
    expect(markup).toContain("report.md");
    expect(markup).not.toContain("@./src/report.md");
  });

  test("助手消息展示文本并使用助手角色样式", () => {
    const markup = renderToStaticMarkup(
      createElement(Message, { from: "assistant" }, createElement(MessageContent, null, "这是助手回复")),
    );

    expect(markup).toContain("这是助手回复");
    expect(markup).toContain("is-assistant");
    expect(markup).not.toContain("is-user ml-auto");
  });

  // Markdown 输出必须保留结构化语义，样式层才能稳定呈现标题、列表、引用、代码和表格。
  test("流式服务端渲染保留完整 Markdown 结构", async () => {
    const markdown = [
      "# 部署结果",
      "",
      "**验证通过**",
      "",
      "- 第一项",
      "- 第二项",
      "",
      "> 克制的引用",
      "",
      "```ts",
      "const ready = true;",
      "```",
      "",
      "| 模块 | 状态 |",
      "| --- | --- |",
      "| Chat | ready |",
    ].join("\n");
    const markup = await renderStreaming(createElement(MessageResponse, null, markdown));

    expect(markup).toContain("chat-markdown-response");
    expect(markup).toContain('<h1 class="mt-6 mb-2 font-semibold text-3xl" data-streamdown="heading-1">部署结果</h1>');
    expect(markup).toContain('<span class="font-semibold" data-streamdown="strong">验证通过</span>');
    expect(markup).toContain('data-streamdown="unordered-list"');
    expect(markup).toContain("<blockquote");
    expect(markup).toContain('data-streamdown="code-block"');
    expect(markup).toContain("<table");
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
    expect(markup.indexOf("The Agent request failed.")).toBeLessThan(
      markup.indexOf("Type: AGENT_RUNTIME.REQUEST_FAILED"),
    );
  });

  // 系统消息只展示标签，并与助手消息正文左边界对齐；原始注入内容不得暴露。
  test("系统消息左对齐且不暴露原始内容", () => {
    const markup = renderToStaticMarkup(
      createElement(SystemMessage, { rawText: "<system-reminder>不可展示</system-reminder>" }),
    );

    expect(markup).toContain('class="flex justify-start"');
    expect(markup).not.toContain("不可展示");
  });

  // system-reminder 标签必须提供中英文资源，不能在中文界面继续显示硬编码英文。
  test("系统消息标签提供中英文翻译", () => {
    expect(componentsZH.messageBubble.systemMessage).toBe("系统提醒");
    expect(componentsEN.messageBubble.systemMessage).toBe("SYSTEM REMINDER");
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
