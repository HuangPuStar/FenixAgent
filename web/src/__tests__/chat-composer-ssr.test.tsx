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

  // 可用 slash 命令和工作区存在时应提供技能与文件入口，方便用户补充上下文。
  test("渲染技能与工作区文件入口", () => {
    const html = renderComposer({
      commands: [{ name: "review", description: "审查代码", input: { hint: "目标文件" } }],
      envId: "env-ssr",
    });

    expect(html).toContain("chatComposer.skillButton");
    expect(html).toContain("chatComposer.fileButton");
    expect(html).toContain("lucide-sparkles");
    expect(html).toContain("lucide-paperclip");
  });

  // token 估算和新建会话回调齐备时应显示进度及新建入口。
  test("渲染 token 进度与新建会话入口", () => {
    const html = renderComposer({
      tokenStats: { estimatedTokens: 40_000, estimatedInputTokens: 30_000, estimatedOutputTokens: 10_000 },
      showNewSession: true,
      onNewSession: () => {},
    });

    expect(html).toContain("20%");
    expect(html).toContain("chatComposer.newSession");
    expect(html).toContain("chat-composer-token-stats");
  });
});
