import { describe, expect, test } from "bun:test";
import ReactDOMServer from "react-dom/server";

// ModelSelectorPopover 内部 useModels hook 访问 client.state.modelState，
// 测试中需提供最小可用 mock 避免崩溃
const mockClient = { state: { modelState: null } } as any;

describe("ChatComposer", () => {
  test("exports as function", async () => {
    const mod = await import("../../components/chat/ChatComposer");
    expect(typeof mod.ChatComposer).toBe("function");
  });

  test("renders without envId (minimal props)", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    expect(() => {
      ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} client={mockClient} />);
    }).not.toThrow();
  });

  test("renders textarea with placeholder", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} client={mockClient} placeholder="给智能体发送消息…" />,
    );
    expect(html).toContain("给智能体发送消息");
  });

  // i18n 未初始化，t() 返回原始 key
  test("renders send button", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} client={mockClient} />);
    expect(html).toContain("chatComposer.send");
  });

  // 元信息条：传入 envId 时应渲染环境标识
  test("renders environment name when envId provided", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} client={mockClient} envId="env_123" />,
    );
    expect(html).toContain("env_123");
  });

  // 元信息条：token 统计应格式化为 k 单位 + 百分比
  test("renders token stats when tokenStats provided", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer
        onSubmit={() => {}}
        client={mockClient}
        tokenStats={{ estimatedTokens: 12300, estimatedInputTokens: 5000, estimatedOutputTokens: 7300 }}
      />,
    );
    expect(html).toContain("12.3k");
    expect(html).toContain("200k");
    // React SSR 在 JSX 表达式和文本之间插入 HTML 注释（6<!-- -->%），需匹配 SSR 格式
    expect(html).toContain("6<!-- -->%");
  });

  // 元信息条：新会话按钮文案（i18n 未初始化时返回 key，参考 fde9e38 做法）
  test("renders new session button when showNewSession is true", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} client={mockClient} showNewSession={true} onNewSession={() => {}} />,
    );
    expect(html).toContain("chatComposer.newSession");
  });
});
