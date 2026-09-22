// 样式迁移守卫（阶段二：会话外壳与空状态）。
//
// 共享工具见 `./chat-style-migration-helpers`。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHeader } from "../chat/shell/ChatHeader";
import { ChatView } from "../chat/view/ChatView";
import { CHAT_DIR, classTokens, MIGRATED_CLASS_NAMES } from "./chat-style-migration-helpers";

describe("chat 样式迁移：外壳与空状态", () => {
  // 顶部卡片：玻璃形态的扁平工具类留在 className，外壳内/暗色/`@supports` 覆写下沉到同目录 CSS。
  test("ChatHeader 卡片深层样式下沉为同目录 CSS", () => {
    const html = renderToStaticMarkup(createElement(ChatHeader, { activeSessionId: null, onSelectSession: () => {} }));
    const tokens = classTokens(html);

    for (const name of MIGRATED_CLASS_NAMES) {
      expect(tokens).not.toContain(name);
    }
    // 独立渲染的玻璃形态：磨砂底 + blur + 圆角仍是 className 里的扁平工具类。
    expect(tokens).toContain("chat-header-panel");
    expect(tokens).toContain("bg-white/72");
    expect(tokens).toContain("rounded-2xl");
    expect(tokens).toContain("backdrop-blur-lg");

    // 外壳内形态（45px、直角、白底、仅底边分隔线）、暗色覆写与 `@supports` 回退在样式表里。
    const css = readFileSync(join(CHAT_DIR, "shell", "ChatHeader.css"), "utf8");
    expect(css).toContain(".acp-main-root .chat-header-panel {");
    expect(css).toContain("height: calc(var(--spacing) * 11.25);");
    expect(css).toContain("border-radius: 0;");
    expect(css).toContain("backdrop-filter: none;");
    expect(css).toContain(".acp-main-root .chat-header-panel:not(.dark *) {");
    expect(css).toContain("background-color: var(--color-white);");
    expect(css).toContain("border-bottom-color: var(--color-gray-100);");
    expect(css).toContain(".dark .chat-header-panel {");
    expect(css).toContain("@supports not ((backdrop-filter: blur(16px)) or (-webkit-backdrop-filter: blur(16px)))");
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
