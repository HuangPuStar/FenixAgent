import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import {
  MessageAction,
  MessageActions,
  MessageAttachment,
  MessageAttachments,
  MessageBranch,
  MessageBranchContent,
  MessageBranchNext,
  MessageBranchPage,
  MessageBranchPrevious,
  MessageBranchSelector,
  MessageResponse,
  MessageToolbar,
} from "../../components/ai-elements/message";

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

describe("消息组件补充分支的服务端渲染", () => {
  // 操作区应保留默认按钮配置，并在提供 tooltip 时输出无障碍名称。
  test("操作区渲染默认操作和提示文本", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MessageToolbar,
        { className: "toolbar" },
        createElement(
          MessageActions,
          { className: "custom-actions" },
          createElement(MessageAction, { tooltip: "复制回复" }, "复制"),
          createElement(MessageAction, { label: "重新生成", variant: "outline" }, "重试"),
        ),
      ),
    );

    expect(markup).toContain("toolbar");
    expect(markup).toContain("custom-actions");
    expect(markup).toContain("复制回复");
    expect(markup).toContain("重新生成");
    expect(markup).toContain('data-variant="outline"');
  });

  // 图片和普通文件走不同展示路径，且有移除回调时才输出移除按钮。
  test("附件按媒体类型展示图片或文件并保留移除操作", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MessageAttachments,
        null,
        createElement(MessageAttachment, {
          data: {
            type: "file",
            filename: "diagram.png",
            mediaType: "image/png",
            url: "https://example.test/diagram.png",
          },
          onRemove: () => {},
        }),
        createElement(MessageAttachment, {
          data: {
            type: "file",
            filename: "notes.txt",
            mediaType: "text/plain",
            url: "https://example.test/notes.txt",
          },
        }),
      ),
    );

    expect(markup).toContain('src="https://example.test/diagram.png"');
    expect(markup).toContain('alt="diagram.png"');
    expect(markup).toContain("lucide-paperclip");
    expect(markup).toContain("message.removeAttachment");
  });

  // 空附件容器不应留下布局节点，避免发送空消息时产生额外间距。
  test("空附件容器不输出标记", () => {
    expect(renderToStaticMarkup(createElement(MessageAttachments, null))).toBe("");
  });

  // 服务端初始状态按默认分支展示对应内容，选择器在尚未同步分支数量时安全隐藏。
  test("分支初始渲染保留选中内容并禁用导航", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MessageBranch,
        { defaultBranch: 1 },
        createElement(
          MessageBranchContent,
          null,
          createElement("p", { key: "first" }, "第一版"),
          createElement("p", { key: "second" }, "第二版"),
        ),
        createElement(MessageBranchSelector, { from: "assistant" }, "选择分支"),
        createElement(MessageBranchPrevious, null),
        createElement(MessageBranchPage, null),
        createElement(MessageBranchNext, null),
      ),
    );

    expect(markup).toContain("第一版");
    expect(markup).toContain("第二版");
    expect(markup).toContain("hidden");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("2 of 0");
    expect(markup).not.toContain("选择分支");
  });

  // 环境文件路径仅重写 user 目录，普通外链保持原样并带新窗口隔离属性。
  test("回复重写环境文件地址且保护外部链接", async () => {
    const markup = await renderStreaming(
      createElement(
        MessageResponse,
        { envId: "env-42" },
        '<iframe src="user/output.html" title="预览"></iframe>\n\n[外部](https://example.test/docs)',
      ),
    );

    expect(markup).toContain("/web/environments/env-42/fs/user/output.html?preview=true");
    expect(markup).toContain('href="https://example.test/docs"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});
