// 样式迁移守卫（阶段三：消息簇与 markdown 排版）。
//
// 共享工具见 `./chat-style-migration-helpers`。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../chat/primitives/message";
import { ChatQuoteMessage } from "../chat/view/ChatQuoteMessage";
import { AssistantBubble, UserBubble } from "../chat/view/MessageBubble";
import { SystemMessage } from "../chat/view/SystemMessage";
import { classTokens, MIGRATED_CLASS_NAMES, renderStreaming } from "./chat-style-migration-helpers";

describe("chat 样式迁移：消息簇", () => {
  // 用户气泡与助手消息（含思考块/操作条）渲染后不带语义类名，锚点与新密度参数生效。
  test("消息气泡渲染结果不含已迁移的语义类名", () => {
    const entry = {
      type: "assistant_message" as const,
      id: "a1",
      chunks: [{ type: "message" as const, text: "正文" }],
    };
    const user = renderToStaticMarkup(
      createElement(UserBubble, { entry: { type: "user_message", id: "u1", content: "保留\n换行" } }),
    );
    const assistant = renderToStaticMarkup(createElement(AssistantBubble, { entry }));
    const compact = renderToStaticMarkup(createElement(AssistantBubble, { entry, compact: true }));

    for (const html of [user, assistant, compact]) {
      for (const name of MIGRATED_CLASS_NAMES) {
        expect(classTokens(html)).not.toContain(name);
      }
    }
    expect(user).toContain('data-slot="chat-user-message-frame"');
    expect(user).toContain('data-slot="chat-user-message-content"');
    expect(user).toContain("保留\n换行");
    // 正文块间距：默认 16px（`gap-4`），活动链内收紧为 4px（`gap-1`，源 `.chat-entry--activity` 那条）。
    expect(assistant).toContain("gap-4");
    expect(compact).toContain("gap-1");
    // 操作条默认隐藏、由助手根节点的具名 group 驱动显示（替代源 `:hover / :focus-within` 父选子）。
    expect(assistant).toContain("group/assistant");
    expect(assistant).toContain("group-hover/assistant:opacity-100");
  });

  // 引用胶囊与系统提醒换成锚点；语义类名与死类名（`message-bubble-enter` 等）都已清空。
  test("引用胶囊与系统提醒使用锚点", () => {
    const quote = renderToStaticMarkup(
      // 夹具去掉 `id`（2026-09-22）：`ChatQuoteMessageProps.quote` 是 `SerializedChatQuote` =
      // `LimitedQuotedText`（`{ text, omittedCharacterCount }`），没有 `id`；带 `id` 的是输入岛侧的
      // `ComposerQuote`（`composer-assets.tsx`，用它当列表 key）。本组件不读 `id`，断言一条未动。
      createElement(ChatQuoteMessage, { quote: { text: "引用正文", omittedCharacterCount: 12 }, index: 0 }),
    );
    const reminder = renderToStaticMarkup(
      createElement(SystemMessage, { rawText: "<system-reminder>x</system-reminder>" }),
    );

    expect(quote).toContain('data-slot="chat-quote-message"');
    expect(quote).toContain("12 chars omitted");
    expect(reminder).toContain('data-slot="chat-system-reminder"');
    for (const html of [quote, reminder]) {
      for (const name of MIGRATED_CLASS_NAMES) {
        expect(classTokens(html)).not.toContain(name);
      }
    }
  });

  // markdown 排版（含 streamdown 内部 DOM）必须挂在容器上：逐条断言几条代表性声明。
  test("markdown 排版容器带后代排版工具类", async () => {
    const html = await renderStreaming(createElement(MessageResponse, null, "# 标题\n\n- 项\n\n> 引用"));
    const tokens = classTokens(html);

    for (const name of MIGRATED_CLASS_NAMES) {
      expect(tokens).not.toContain(name);
    }
    // 元素级（源 `.chat-markdown-content` / `.chat-markdown-response`）
    expect(tokens).toContain("text-[#27364f]");
    expect(tokens).toContain("text-[14px]");
    expect(tokens).toContain("wrap-anywhere");
    // 后代：标题、列表、引用、streamdown 代码块头部
    expect(tokens).toContain("[&_h1]:text-[22px]");
    expect(tokens).toContain("[&_ul]:list-disc");
    expect(tokens).toContain("[&_blockquote]:pl-0");
    expect(tokens).toContain("[&_[data-streamdown=code-block-header]]:hidden");
  });

  // Conversation 的滚动按钮只在「已向上滚动」时渲染（SSR 到不了那一支），故以源码级检查守住类名不回流。
  test("Conversation 滚动按钮的源码里不再使用语义类名", () => {
    const src = readFileSync(join(import.meta.dir, "..", "chat", "primitives", "conversation.tsx"), "utf8");
    // 只看 className 表达式里的类名（注释中会写「源 `.chat-scroll-to-latest`」这类溯源说明）。
    const classExpressions = [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{cn\(([\s\S]*?)\)\})/g)]
      .flatMap((match) => match.slice(1).filter((value): value is string => typeof value === "string"))
      .join(" ")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    expect(classExpressions).not.toContain("chat-scroll-to-latest");
    expect(classExpressions).not.toContain("chat-scroll-navigation");
    expect(src).not.toContain('import "./conversation.css"');
  });
});
