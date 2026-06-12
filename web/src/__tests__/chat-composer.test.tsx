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
      ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} client={{} as any} />);
    }).not.toThrow();
  });

  test("renders textarea with placeholder", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} client={{} as any} placeholder="给智能体发送消息…" />,
    );
    expect(html).toContain("给智能体发送消息");
  });

  test("renders send button", async () => {
    const { ChatComposer } = await import("../../components/chat/ChatComposer");
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} client={{} as any} />);
    expect(html).toContain("发送");
  });
});
