import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatView } from "../../components/chat/ChatView";
import zhComponents from "../i18n/locales/zh/components.json";
import type { ThreadEntry } from "../lib/types";

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

  // 推荐提示词应引导用户先讨论思路、风险和取舍，而不是要求 Agent 直接行动。
  test("推荐讨论型起始话题", () => {
    expect(zhComponents.chatEmpty.eyebrow).toBe("从一次充分讨论开始");
    expect(zhComponents.chatEmpty.suggestionReview).toBe("讨论代码变更的思路与风险");
    expect(zhComponents.chatEmpty.suggestionPlan).toBe("讨论技术方案的选择与取舍");
    expect(zhComponents.chatEmpty.suggestionBuild).toBe("讨论构建失败的可能原因");
  });

  // 可见正文后紧接工具调用时应标记专用紧凑边界，避免出现过大的垂直空白。
  test("正文后的工具调用使用紧凑间距", () => {
    const entries: ThreadEntry[] = [
      { type: "assistant_message", id: "assistant-1", chunks: [{ type: "message", text: "开始读取文件" }] },
      {
        type: "tool_call",
        toolCall: { id: "tool-1", title: "Read", kind: "read-file", status: "complete" },
      },
    ];
    const markup = renderToStaticMarkup(<ChatView entries={entries} />);

    expect(markup).toContain("chat-activity-chain chat-activity-chain--after-message");
  });
});
