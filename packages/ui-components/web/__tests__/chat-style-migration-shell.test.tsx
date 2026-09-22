// 样式迁移守卫（阶段二：会话外壳与空状态）。
//
// 共享工具见 `./chat-style-migration-helpers`。

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHeader } from "../chat/shell/ChatHeader";
import { ChatView } from "../chat/view/ChatView";
import { classTokens, MIGRATED_CLASS_NAMES } from "./chat-style-migration-helpers";

describe("chat 样式迁移：外壳与空状态", () => {
  // 顶部卡片：`chat-header-card` 类名已删除，独立渲染的玻璃形态与外壳内（ACP 子树）平面形态都由工具类表达。
  test("ChatHeader 卡片样式已内联为工具类", () => {
    const html = renderToStaticMarkup(createElement(ChatHeader, { activeSessionId: null, onSelectSession: () => {} }));
    const tokens = classTokens(html);

    for (const name of MIGRATED_CLASS_NAMES) {
      expect(tokens).not.toContain(name);
    }
    // 玻璃形态（独立渲染）：半透明底 + blur + 圆角；外壳内形态：45px、直角、白底、单独底边。
    expect(tokens).toContain("backdrop-blur-[16px]");
    expect(tokens).toContain("[.acp-main-root_&]:h-[45px]");
    expect(tokens).toContain("[.acp-main-root_&:not(.dark_*)]:bg-white");
    expect(tokens).toContain("[.dark_&]:bg-[rgba(45,45,47,0.72)]");
    expect(tokens).toContain(
      "[@supports_not_((backdrop-filter:blur(16px))_or_(-webkit-backdrop-filter:blur(16px)))]:bg-[var(--color-surface-1)]",
    );
  });

  // 空状态与消息容器：语义类名换成 `data-slot` 锚点 + 工具类（选区判定与宿主测试都依赖锚点）。
  test("空状态与消息容器使用锚点与工具类", () => {
    const html = renderToStaticMarkup(createElement(ChatView, { entries: [] }));
    const tokens = classTokens(html);

    for (const name of MIGRATED_CLASS_NAMES) {
      expect(tokens).not.toContain(name);
    }
    expect(html).toContain('data-slot="chat-empty-state"');
    expect(html).toContain('data-slot="chat-empty-suggestions"');
    expect(html).toContain('data-slot="chat-conversation-content"');
  });
});
