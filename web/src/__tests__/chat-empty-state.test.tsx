import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatView } from "../../components/chat/ChatView";

describe("Chat 空状态", () => {
  // 首次进入会话时应渲染设计稿中的引导层级和三个可选起始任务，而不是旧工牌卡。
  test("按设计稿渲染引导内容", () => {
    const markup = renderToStaticMarkup(
      <ChatView
        entries={[]}
        agentName="Code Agent"
        emptyTitle="今天想完成什么？"
        emptyDescription="描述目标、贴入上下文，或从一个常见任务开始。"
      />,
    );

    expect(markup).toContain("chat-empty-state");
    expect(markup).toContain("brand/fenix-agent-logo-mark.png");
    expect(markup).toContain("今天想完成什么？");
    expect(markup).toContain("chatEmpty.suggestionReview");
    expect(markup).toContain("chatEmpty.suggestionPlan");
    expect(markup).toContain("chatEmpty.suggestionBuild");
    expect(markup).not.toContain("agent-badge");
  });
});
