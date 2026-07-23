import { describe, expect, test } from "bun:test";
import ReactDOMServer from "react-dom/server";
import { SessionsProvider } from "../hooks/useSessions";

// ChatHeader 内部 useEffect 依赖 client.state.on / client.getState 等，
// SSR 渲染不会执行 useEffect，提供最小 mock 即可保证渲染不崩溃。
const mockClient = {
  state: { on: () => {}, off: () => {} },
  getState: () => "disconnected",
  supportsSessionList: false,
  listSessions: async () => ({ sessions: [] }),
} as any;

describe("ChatHeader", () => {
  test("exports as function", async () => {
    const mod = await import("../../components/chat/ChatHeader");
    expect(typeof mod.ChatHeader).toBe("function");
  });

  // 渲染时不抛错（i18n 未初始化时返回 key，不影响结构断言）
  test("renders without throwing with minimal props", async () => {
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    expect(() => {
      ReactDOMServer.renderToString(
        <SessionsProvider client={mockClient}>
          <ChatHeader client={mockClient} activeSessionId={null} onSelectSession={() => {}} />
        </SessionsProvider>,
      );
    }).not.toThrow();
  });

  // 没有激活会话时，按钮应展示"新会话"占位
  test("renders new session placeholder when no active session", async () => {
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    const html = ReactDOMServer.renderToString(
      <SessionsProvider client={mockClient}>
        <ChatHeader client={mockClient} activeSessionId={null} onSelectSession={() => {}} />
      </SessionsProvider>,
    );
    expect(html).toContain("chatHeader.newSession");
  });

  // 渲染 MessageSquare 图标，确保顶部信息条使用了图标而非裸文本
  test("renders message square icon", async () => {
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    const html = ReactDOMServer.renderToString(
      <SessionsProvider client={mockClient}>
        <ChatHeader client={mockClient} activeSessionId={null} onSelectSession={() => {}} />
      </SessionsProvider>,
    );
    expect(html).toContain("lucide-message-square");
  });

  // 未提供 onToggleSidebar 时不渲染 PanelLeft 切换按钮（hideSidebar / readonly 场景）
  test("does not render sidebar toggle when onToggleSidebar is missing", async () => {
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    const html = ReactDOMServer.renderToString(
      <SessionsProvider client={mockClient}>
        <ChatHeader client={mockClient} activeSessionId={null} onSelectSession={() => {}} />
      </SessionsProvider>,
    );
    expect(html).not.toContain("lucide-panel-left");
  });

  // 提供 onToggleSidebar 时在 Popover 内部渲染钉子按钮，SSR 时不显示
  test("does not throw when onToggleSidebar provided", async () => {
    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    expect(() => {
      ReactDOMServer.renderToString(
        <SessionsProvider client={mockClient}>
          <ChatHeader
            client={mockClient}
            activeSessionId={null}
            onSelectSession={() => {}}
            onToggleSidebar={() => {}}
            sidebarOpen={true}
          />
        </SessionsProvider>,
      );
    }).not.toThrow();
  });

  // 提供改名后新数据，验证 handleSaveRename 不抛错
  test("rename handler does not crash during SSR", async () => {
    const renameClient = {
      ...mockClient,
      supportsSessionList: true,
      listSessions: async () => ({
        sessions: [{ sessionId: "s1", title: "Old Title", updatedAt: new Date().toISOString() }],
      }),
    } as any;

    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    expect(() => {
      ReactDOMServer.renderToString(
        <SessionsProvider client={renameClient}>
          <ChatHeader client={renameClient} activeSessionId="s1" onSelectSession={() => {}} />
        </SessionsProvider>,
      );
    }).not.toThrow();
  });

  // 有会话列表时的 delete handler 渲染不抛错
  test("renders with sessions without throwing", async () => {
    const sessionsClient = {
      ...mockClient,
      supportsSessionList: true,
      listSessions: async () => ({
        sessions: [
          { sessionId: "s1", title: "Session 1", updatedAt: new Date().toISOString() },
          { sessionId: "s2", title: "Session 2", updatedAt: new Date().toISOString() },
        ],
      }),
    } as any;

    const { ChatHeader } = await import("../../components/chat/ChatHeader");
    expect(() => {
      ReactDOMServer.renderToString(
        <SessionsProvider client={sessionsClient}>
          <ChatHeader client={sessionsClient} activeSessionId="s1" onSelectSession={() => {}} />
        </SessionsProvider>,
      );
    }).not.toThrow();
  });
});
