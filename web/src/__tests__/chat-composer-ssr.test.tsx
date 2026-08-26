import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

import { ChatComposer } from "../../components/chat/ChatComposer";
import i18n from "../i18n";

function renderComposer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ChatComposer, {
        onSubmit: () => {},
        ...props,
      }),
    ),
  );
}

describe("ChatComposer 服务端渲染", () => {
  // 空闲输入框应展示占位提示和可发送的主操作，供用户开始新对话。
  test("空闲状态渲染输入框与发送操作", () => {
    const html = renderComposer();

    expect(html).toContain("chatInput.placeholder");
    expect(html).toContain("lucide-send");
    expect(html).toContain("chat-composer-textarea");
  });

  // 外部禁用时输入和发送入口都必须禁用，避免将消息提交给不可用的会话。
  test("禁用状态锁定输入与发送操作", () => {
    const html = renderComposer({ disabled: true, placeholder: "会话已锁定" });

    expect(html).toContain("会话已锁定");
    expect(html).toContain('disabled=""');
  });

  // 可取消的运行中 turn 必须展示停止操作，不应退化为新的发送按钮。
  test("可取消运行展示停止操作", () => {
    const html = renderComposer({ isLoading: true, canCancel: true });

    expect(html).toContain("lucide-square");
    expect(html).not.toContain("lucide-send");
  });

  // 取消请求已发出时停止操作保持禁用，避免用户重复发送 cancel RPC。
  test("取消中停止操作禁用", () => {
    const html = renderComposer({ isLoading: true, canCancel: false });

    expect(html).toContain("lucide-square");
    expect(html).toContain('disabled=""');
  });

  // 已选择模型应在输入框下方展示，帮助用户确认当前会话所用模型。
  test("渲染当前模型名称", () => {
    const html = renderComposer({ modelName: "Claude Test" });

    expect(html).toContain("Claude Test");
  });

  // 可用 slash 命令和工作区存在时应提供真实能力与附件入口。
  test("渲染命令与附件入口", () => {
    const html = renderComposer({
      commands: [{ name: "review", description: "审查代码", input: { hint: "目标文件" } }],
      envId: "env-ssr",
    });

    expect(html).toContain("chatComposer.commandButton");
    expect(html).toContain("lucide-blocks");
    expect(html).toContain("lucide-paperclip");
  });

  // 协议真实 token 用量只显示绝对值，不伪造上下文百分比。
  test("渲染真实 token 用量与新建会话入口", () => {
    const html = renderComposer({
      contextUsage: { totalTokens: 40_000, inputTokens: 30_000, outputTokens: 10_000 },
      showNewSession: true,
      onNewSession: () => {},
    });

    expect(html).toContain("40.0k");
    expect(html).toContain("chatComposer.newSession");
    expect(html).toContain("chat-composer-context");
  });
});
