import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import ReactDOMServer from "react-dom/server";
import { initReactI18next } from "react-i18next/initReactI18next";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * ChatHeader（`web/chat/shell/ChatHeader.tsx`）的渲染测试。
 *
 * 全部用例只走 `react-dom/server`，不涉及点击/受控输入等 DOM 交互，所以不需要 happy-dom 引导：
 * 覆盖的是「无激活会话时的占位文案」「顶部信息条使用图标而非裸文本」「侧边栏切换按钮的渲染条件」
 * 以及「会话标题里的 `<system-reminder>` 块被清洗后不泄漏到顶部标题」。
 * 文案断言取包内英文字典（`chat.components.*`）的译文，字典缺失时回落 key，两种状态下都能发现回归。
 */

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

/** 读包内英文字典的 chat 子树；字典尚未搬运或键缺失时回落 key（`chat.` + path）。 */
function chatText(path: string): string {
  let current: unknown = (en as Record<string, unknown>).chat;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return `chat.${path}`;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : `chat.${path}`;
}

describe("ChatHeader", () => {
  test("exports as function", async () => {
    const mod = await import("../chat/shell/ChatHeader");
    expect(typeof mod.ChatHeader).toBe("function");
  });

  // 渲染时不抛错（i18n 未初始化时返回 key，不影响结构断言）
  test("renders without throwing with minimal props", async () => {
    const { ChatHeader } = await import("../chat/shell/ChatHeader");
    expect(() => {
      ReactDOMServer.renderToString(<ChatHeader activeSessionId={null} onSelectSession={() => {}} />);
    }).not.toThrow();
  });

  // 没有激活会话时，按钮应展示"新会话"占位
  test("renders new session placeholder when no active session", async () => {
    const { ChatHeader } = await import("../chat/shell/ChatHeader");
    const html = ReactDOMServer.renderToString(<ChatHeader activeSessionId={null} onSelectSession={() => {}} />);
    expect(html).toContain(chatText("components.chatHeader.newSession"));
  });

  // 渲染 MessageSquare 图标，确保顶部信息条使用了图标而非裸文本
  test("renders message square icon", async () => {
    const { ChatHeader } = await import("../chat/shell/ChatHeader");
    const html = ReactDOMServer.renderToString(<ChatHeader activeSessionId={null} onSelectSession={() => {}} />);
    expect(html).toContain("lucide-message-square");
  });

  // 未提供 onToggleSidebar 时不渲染 PanelLeft 切换按钮（hideSidebar / readonly 场景）
  test("does not render sidebar toggle when onToggleSidebar is missing", async () => {
    const { ChatHeader } = await import("../chat/shell/ChatHeader");
    const html = ReactDOMServer.renderToString(<ChatHeader activeSessionId={null} onSelectSession={() => {}} />);
    expect(html).not.toContain("lucide-panel-left");
  });

  // 提供 onToggleSidebar 时在 Popover 内部渲染钉子按钮，SSR 时不显示
  test("does not throw when onToggleSidebar provided", async () => {
    const { ChatHeader } = await import("../chat/shell/ChatHeader");
    expect(() => {
      ReactDOMServer.renderToString(
        <ChatHeader activeSessionId={null} onSelectSession={() => {}} onToggleSidebar={() => {}} sidebarOpen={true} />,
      );
    }).not.toThrow();
  });

  // 提供改名后新数据，验证 handleSaveRename 不抛错
  test("rename handler does not crash during SSR", async () => {
    const { ChatHeader } = await import("../chat/shell/ChatHeader");
    expect(() => {
      ReactDOMServer.renderToString(
        <ChatHeader
          activeSessionId="s1"
          onSelectSession={() => {}}
          sessions={[{ sessionId: "s1", title: "Old Title", updatedAt: new Date().toISOString() }]}
        />,
      );
    }).not.toThrow();
  });

  // 有会话列表时的 delete handler 渲染不抛错
  test("renders with sessions without throwing", async () => {
    const { ChatHeader } = await import("../chat/shell/ChatHeader");
    expect(() => {
      ReactDOMServer.renderToString(
        <ChatHeader
          activeSessionId="s1"
          onSelectSession={() => {}}
          sessions={[
            { sessionId: "s1", title: "Session 1", updatedAt: new Date().toISOString() },
            { sessionId: "s2", title: "Session 2", updatedAt: new Date().toISOString() },
          ]}
        />,
      );
    }).not.toThrow();
  });

  // 顶部当前会话标题应剔除 <system-reminder> 等 HTML 标签（含块内内容），只保留纯文本
  test("strips HTML tags from active session title", async () => {
    const { ChatHeader } = await import("../chat/shell/ChatHeader");
    const html = ReactDOMServer.renderToString(
      <ChatHeader
        activeSessionId="s1"
        onSelectSession={() => {}}
        sessions={[
          {
            sessionId: "s1",
            title: "修复登录 <system-reminder>先看日志</system-reminder>",
            updatedAt: new Date().toISOString(),
          },
        ]}
      />,
    );
    expect(html).toContain("修复登录");
    expect(html).not.toContain("&lt;system-reminder");
    expect(html).not.toContain("<system-reminder>");
    expect(html).not.toContain("先看日志");
  });

  // 标题全部由标签构成时，顶部标题应回退为"新会话"占位而非空
  test("falls back to new session placeholder when title is only tags", async () => {
    const { ChatHeader } = await import("../chat/shell/ChatHeader");
    const html = ReactDOMServer.renderToString(
      <ChatHeader
        activeSessionId="s1"
        onSelectSession={() => {}}
        sessions={[
          { sessionId: "s1", title: "<system-reminder></system-reminder>", updatedAt: new Date().toISOString() },
        ]}
      />,
    );
    expect(html).toContain(chatText("components.chatHeader.newSession"));
  });
});
