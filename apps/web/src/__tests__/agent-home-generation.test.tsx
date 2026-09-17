import { describe, expect, test } from "bun:test";
import { hasAgentGenerationPrompt } from "../pages/agent-panel/pages/AgentHomePage";

const agentHomeSource = Bun.file(new URL("../pages/agent-panel/pages/AgentHomePage.tsx", import.meta.url));

describe("Agent 首页生成输入校验", () => {
  // 空字符串和纯空白不应启用一键创建，避免点击按钮后没有任何反馈。
  test("拒绝空白描述", () => {
    expect(hasAgentGenerationPrompt("")).toBe(false);
    expect(hasAgentGenerationPrompt(" \n\t ")).toBe(false);
  });

  // 包含实际内容的描述应允许进入 Agent 配置生成流程。
  test("接受有效描述", () => {
    expect(hasAgentGenerationPrompt("创建一个代码审查 Agent")).toBe(true);
  });

  // 首页提交必须复用统一的实例进入流程，并携带实例 UID 导航，避免聊天页永久等待。
  test("创建后显式进入实例并导航到实例路由", async () => {
    const source = await agentHomeSource.text();

    expect(source).toContain("resolveCreatedAgentChatTarget(agentConfigId");
    expect(source).toContain('to: "/agent/chat/$agentId/$sessionId"');
    expect(source).toContain("sessionId: target.instanceUid");
  });
});
