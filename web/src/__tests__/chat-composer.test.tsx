import { describe, expect, test } from "bun:test";
import ReactDOMServer from "react-dom/server";

describe("ChatComposer", () => {
  test("exports as function", async () => {
    const mod = await import("../../components/chat/ChatComposer");
    expect(typeof mod.ChatComposer).toBe("function");
  });

  test("renders without envId (minimal props)", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    expect(() => {
      ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} />);
    }).not.toThrow();
  });

  test("renders textarea with placeholder", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} placeholder="给智能体发送消息…" />);
    expect(html).toContain("给智能体发送消息");
  });

  // 发送按钮现在是纯图标（无文字），检查 lucide Send 图标存在
  test("renders send button", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} />);
    expect(html).toContain("lucide-send");
  });

  // 元信息条：token 进度条宽度 + 百分比（数字文字已移除）
  test("renders token stats when tokenStats provided", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer
        onSubmit={() => {}}
        tokenStats={{ estimatedTokens: 12300, estimatedInputTokens: 5000, estimatedOutputTokens: 7300 }}
      />,
    );
    // 进度条 input token 宽度 2.5%（5000/200000）
    expect(html).toContain("width:2.5%");
    // React SSR 在 JSX 表达式和文本之间插入 HTML 注释（6<!-- -->%），需匹配 SSR 格式
    expect(html).toContain("6<!-- -->%");
  });

  // 元信息条：新会话按钮文案（i18n 未初始化时返回 key，参考 fde9e38 做法）
  test("renders new session button when showNewSession is true", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} showNewSession={true} onNewSession={() => {}} />,
    );
    expect(html).toContain("chatComposer.newSession");
  });

  // 浮动按钮组：技能按钮在有 commands 和 envId 时渲染
  test("renders skill and file buttons when commands and envId provided", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const mockCommands = [
      { name: "review", description: "Code review" },
      { name: "test", description: "Run tests" },
    ];
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} commands={mockCommands} envId="env_test" />,
    );
    // 检查技能按钮存在（SSR 下 i18n 回退到 key）
    expect(html).toContain("chatComposer.skillButton");
    // 检查文件按钮存在
    expect(html).toContain("chatComposer.fileButton");
  });

  // 浮动按钮组：仅有 commands 无 envId 时，只有技能按钮
  test("renders only skill button when no envId", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const mockCommands = [{ name: "review", description: "Code review" }];
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} commands={mockCommands} />);
    expect(html).toContain("chatComposer.skillButton");
    expect(html).not.toContain("chatComposer.fileButton");
  });

  // 浮动按钮组：仅有 envId 无 commands 时，只有文件按钮
  test("renders only file button when no commands", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} envId="env_test" />);
    expect(html).not.toContain("chatComposer.skillButton");
    expect(html).toContain("chatComposer.fileButton");
  });

  // 浮动按钮组：commands 为空数组时不显示技能按钮，无 envId 时不显示文件按钮
  test("renders no buttons when commands empty array and no envId", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} commands={[]} />);
    expect(html).not.toContain("chatComposer.skillButton");
    expect(html).not.toContain("chatComposer.fileButton");
  });
});
