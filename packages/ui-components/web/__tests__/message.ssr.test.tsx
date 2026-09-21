// 消息组件的服务端渲染测试（CE 阶段 2 §1.6 T6c1 从
// `packages/agent-runtime/web/src/__tests__/message.ssr.test.tsx` 迁入包内，
// 旧聊天实现整体退场，用例随实现迁入 owner 包）。
//
// 迁移改动（用例名与中文注释逐字保留，只按包内契约改写断言的取值来源与导入路径）：
// - 导入路径按 A→B 表改写：`@/components/chat/MessageBubble` → `../chat/view/MessageBubble`，
//   `@/components/chat/SubAgentPanel` → `../chat/timeline/SubAgentPanel`，
//   `@/components/chat/SystemMessage` → `../chat/view/SystemMessage`。
// - 旧用例从宿主 `apps/web/components/ai-elements/message` 取 `Message` / `MessageContent` /
//   `MessageResponse`（该目录已随 T5 迁入本包，即 `../chat/primitives/message`），包内直接相对导入，
//   不再依赖宿主 `apps/web`。
// - i18n 从宿主单例 `@/src/i18n/locales/{en,zh}/components.json`（键 `messageBubble.*`）换成包内字典
//   `../i18n/locales/{en,zh}/uiComponents.json`（同键位于 `chat.components.messageBubble.*`）。
//   组件经 `useTranslation` 读包内命名空间，故渲染统一包 `I18nextProvider`；SSR 不需要 DOM 引导。
// - 宿主桩改 prop 注入：本文件旧用例不含 `@/src/api/*`、`@/src/hooks/*` 一类宿主桩；`UserBubble` 的
//   文件预览在上线态由 `onOpenWorkspaceFile` 回调门控（旧实现走宿主 window 事件），用例仍只断言
//   附件 pill 的渲染契约，无需注入该回调。
// - 已登记的有意取舍（`docs/design/ce-ee-refactoring/review/task-1.6-web-shell.md` §8.2 与
//   `packages/ui-components/README.md`「已知取舍」表）覆盖 ToolCallRow 的 `publicError` 块 / 完成态
//   状态词与 TodoChanges 的变更标签，均不属于本文件用例，故本文件无删除项。

import { describe, expect, test } from "bun:test";
import { createInstance, type i18n as I18nInstance } from "i18next";
import { createElement, type ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";
import { Message, MessageContent, MessageResponse } from "../chat/primitives/message";
import { SubAgentPanel } from "../chat/timeline/SubAgentPanel";
import { AssistantBubble, UserBubble } from "../chat/view/MessageBubble";
import { SystemMessage } from "../chat/view/SystemMessage";
import en from "../i18n/locales/en/uiComponents.json";
import zh from "../i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const i18n: I18nInstance = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: {
    en: { [UI_COMPONENTS_NS]: en },
    zh: { [UI_COMPONENTS_NS]: zh },
  },
});

/**
 * 读包内字典的 `chat.components` 子树（旧文件的键 `messageBubble.*` 在包内加了 `chat.components.`
 * 前缀）。用例里的 i18n 断言一律经此取值，避免把前缀散落在断言里。
 */
function messageBubbleText(dict: unknown, key: string): unknown {
  let current: unknown = (dict as Record<string, unknown>).chat;
  for (const part of `components.messageBubble.${key}`.split(".")) {
    if (typeof current !== "object" || current === null) return;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** 组件经 `useTranslation` 读包内命名空间，SSR 渲染统一包 `I18nextProvider`。 */
function renderMarkup(element: ReactNode): string {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));
}

async function renderStreaming(element: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(createElement(I18nextProvider, { i18n }, element));
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
    const markup = renderMarkup(
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
    const markup = renderMarkup(
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
    const markup = renderMarkup(
      createElement(UserBubble, {
        entry: { type: "user_message", id: "file-reference", content: "请检查\n@./src/report.md" },
        envId: "env-a",
      }),
    );

    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('data-file-attachment="src/report.md"');
    expect(markup).toContain("report.md");
    expect(markup).not.toContain("@./src/report.md");
  });

  test("助手消息展示文本并使用助手角色样式", () => {
    const markup = renderMarkup(
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
    const markup = renderMarkup(
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

  // Chat 引用从 reminder 投影为专用引用胶囊，正文保持用户消息且不误显示系统提醒胶囊。
  test("用户消息将结构化引用显示为引用胶囊", () => {
    const quotePayload = JSON.stringify([{ text: "需要单独展示的引用正文", omittedCharacterCount: 23 }]);
    const markup = renderMarkup(
      createElement(UserBubble, {
        entry: {
          type: "user_message",
          id: "quoted-prompt",
          content: `<system-reminder>\nChat quotes for this turn (JSON): ${quotePayload}\n</system-reminder>\n\n我引用了什么`,
        },
      }),
    );

    expect(markup).toContain("我引用了什么");
    expect(markup).toContain("chat-quote-message");
    expect(markup).toContain("需要单独展示的引用正文");
    expect(markup).not.toContain("chat-system-reminder");
  });

  // 非引用 system-reminder 恢复为系统提醒胶囊，但内部原始内容仍不暴露。
  test("用户消息将非引用 system-reminder 显示为系统提醒胶囊", () => {
    const markup = renderMarkup(
      createElement(UserBubble, {
        entry: {
          type: "user_message",
          id: "quoted-prompt",
          content: "<system-reminder>引用正文</system-reminder>\n\n我引用了什么",
        },
      }),
    );

    expect(markup).toContain("我引用了什么");
    expect(markup).not.toContain("引用正文");
    expect(markup).toContain("chat-system-reminder");
  });

  // 系统消息默认隐藏原始注入内容，并与助手消息正文左边界对齐。
  test("系统消息默认隐藏原始内容", () => {
    const markup = renderMarkup(
      createElement(SystemMessage, { rawText: "<system-reminder>不可展示</system-reminder>" }),
    );

    expect(markup).toContain('class="flex justify-start"');
    expect(markup).not.toContain("不可展示");
  });

  // system-reminder 标签和详情交互必须提供中英文资源，不能在中文界面继续显示硬编码英文。
  // （迁移：键前缀由宿主 `messageBubble.*` 变为包内 `chat.components.messageBubble.*`，语义不变。）
  test("系统消息标签提供中英文翻译", () => {
    expect(messageBubbleText(zh, "systemMessage")).toBe("系统提醒");
    expect(messageBubbleText(zh, "openSystemMessage")).toBe("双击查看系统提醒详情");
    expect(messageBubbleText(en, "systemMessage")).toBe("SYSTEM REMINDER");
    expect(messageBubbleText(en, "openSystemMessage")).toBe("Double-click to view system reminder details");
  });

  // 子 Agent 详情默认折叠，避免占满父工具调用。
  // 摘要文案随 i18n 状态变化，这里按折叠契约断言（触发器 aria-expanded=false 且内容不渲染）。
  test("子 Agent 执行轨迹默认折叠", () => {
    const markup = renderMarkup(
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

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("已完成调研");
  });
});
