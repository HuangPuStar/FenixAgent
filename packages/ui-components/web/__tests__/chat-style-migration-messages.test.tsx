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
import { CHAT_DIR, classTokens, MIGRATED_CLASS_NAMES, renderStreaming } from "./chat-style-migration-helpers";

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

  // markdown 排版（含 streamdown 内部 DOM）必须挂在容器上：容器只留语义类名与扁平工具类，
  // 选择器／复合值／媒体查询落在同目录 CSS，逐条断言几条代表性声明。
  test("markdown 排版容器的深层样式落在同目录 CSS 里", async () => {
    const html = await renderStreaming(createElement(MessageResponse, null, "# 标题\n\n- 项\n\n> 引用"));
    const tokens = classTokens(html);

    for (const name of MIGRATED_CLASS_NAMES) {
      expect(tokens).not.toContain(name);
    }
    // 容器自身：语义类名 + 仍然扁平的换行约束（源 `.chat-markdown-content` / `.chat-markdown-response`）
    expect(tokens).toContain("chat-markdown-content-styles");
    expect(tokens).toContain("wrap-anywhere");
    expect(tokens).toContain("whitespace-normal");
    // 后代规则（标题、列表、引用、streamdown 代码块头部）落在 CSS 文件里
    const css = readFileSync(join(CHAT_DIR, "primitives", "internal", "markdown-classes.css"), "utf8");
    expect(css).toContain("color: #27364f;");
    expect(css).toContain("font-size: 14px;");
    expect(css).toContain(".chat-markdown-content-styles h1 {");
    expect(css).toContain("list-style-type: disc;");
    expect(css).toContain('[data-streamdown="code-block-header"]');
  });

  // 深层样式下沉：`className` 只留扁平工具类与语义类名，选择器/复合值/媒体查询落在同目录 CSS。
  test("消息气泡与引用胶囊的深层样式落在同目录 CSS 里", () => {
    const quote = renderToStaticMarkup(
      createElement(ChatQuoteMessage, { quote: { text: "引用正文", omittedCharacterCount: 3 }, index: 0 }),
    );
    const assistant = renderToStaticMarkup(
      createElement(AssistantBubble, {
        entry: {
          type: "assistant_message" as const,
          id: "a-css",
          chunks: [
            { type: "thought" as const, text: "想想" },
            { type: "message" as const, text: "正文" },
          ],
        },
      }),
    );

    expect(classTokens(quote)).toContain("chat-quote-summary");
    expect(classTokens(quote)).toContain("chat-quote-preview");
    const quoteCss = readFileSync(join(CHAT_DIR, "view", "ChatQuoteMessage.css"), "utf8");
    expect(quoteCss).toContain(".chat-quote-summary::-webkit-details-marker");
    expect(quoteCss).toContain(".chat-quote-summary > svg");
    expect(quoteCss).toContain("top: calc(100% + 6px);");
    expect(quoteCss).toContain("width: min(340px, calc(100vw - 48px));");
    expect(quoteCss).toContain("box-shadow: 0 8px 24px rgb(38 52 77 / 14%);");

    // 操作条：`opacity` / `pointer-events` / `transform` 的基础值与 group 显示态仍是工具类。
    expect(classTokens(assistant)).toContain("chat-message-action-bar");
    expect(classTokens(assistant)).toContain("chat-thought-trigger");
    expect(classTokens(assistant)).toContain("group-hover/assistant:opacity-100");
    const bubbleCss = readFileSync(join(CHAT_DIR, "view", "MessageBubble.css"), "utf8");
    expect(bubbleCss).toContain("top: calc(100% - 2px);");
    expect(bubbleCss).toContain("box-shadow: 0 6px 18px rgb(30 50 80 / 12%);");
    expect(bubbleCss).toContain("@media (hover: none)");
    expect(bubbleCss).toContain("border-radius: 14px 14px 4px 14px;");
    expect(bubbleCss).toContain(".chat-thought-trigger > svg:first-child");
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
