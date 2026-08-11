import { describe, expect, test } from "bun:test";
import ReactDOMServer from "react-dom/server";

describe("ChatHeader", () => {
  test("exports as function", async () => {
    const mod = await import("../../components/chat/ChatHeader");
    expect(typeof mod.ChatHeader).toBe("function");
  });

  // 渲染时不抛错（i18n 未初始化时返回 key，不影响结构断言）
  test("renders without throwing with minimal props", async () => {
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    expect(() => {
      ReactDOMServer.renderToString(<ChatHeader activeSessionId={null} onSelectSession={() => {}} />);
    }).not.toThrow();
  });

  // 没有激活会话时，按钮应展示"新会话"占位
  test("renders new session placeholder when no active session", async () => {
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    const html = ReactDOMServer.renderToString(<ChatHeader activeSessionId={null} onSelectSession={() => {}} />);
    expect(html).toContain("chatHeader.newSession");
  });

  // 渲染 MessageSquare 图标，确保顶部信息条使用了图标而非裸文本
  test("renders message square icon", async () => {
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    const html = ReactDOMServer.renderToString(<ChatHeader activeSessionId={null} onSelectSession={() => {}} />);
    expect(html).toContain("lucide-message-square");
  });

  // 未提供 onToggleSidebar 时不渲染 PanelLeft 切换按钮（hideSidebar / readonly 场景）
  test("does not render sidebar toggle when onToggleSidebar is missing", async () => {
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    const html = ReactDOMServer.renderToString(<ChatHeader activeSessionId={null} onSelectSession={() => {}} />);
    expect(html).not.toContain("lucide-panel-left");
  });

  // 提供 onToggleSidebar 时在 Popover 内部渲染钉子按钮，SSR 时不显示
  test("does not throw when onToggleSidebar provided", async () => {
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    expect(() => {
      ReactDOMServer.renderToString(
        <ChatHeader activeSessionId={null} onSelectSession={() => {}} onToggleSidebar={() => {}} sidebarOpen={true} />,
      );
    }).not.toThrow();
  });

  // 提供改名后新数据，验证 handleSaveRename 不抛错
  test("rename handler does not crash during SSR", async () => {
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
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
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
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
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
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
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    const html = ReactDOMServer.renderToString(
      <ChatHeader
        activeSessionId="s1"
        onSelectSession={() => {}}
        sessions={[
          { sessionId: "s1", title: "<system-reminder></system-reminder>", updatedAt: new Date().toISOString() },
        ]}
      />,
    );
    expect(html).toContain("chatHeader.newSession");
  });
});
